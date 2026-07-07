import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'

/**
 * LG Dishwasher
 * Official model: DB365TXS (6-place setting, heat-pump)
 * ThinQ model:    D0211
 * Platform:       ThinQ2, custom binary protocol (NOT TLV)
 *
 * Frame format:  AA <totalLen> <cmd1> <cmd2> <data...> <crc8> BB
 *   totalLen includes AA and BB. CRC is the byte before BB.
 *
 * Packet types (device → cloud, cmd1=0x32):
 *   0x32 0xEB  – single state record (26 bytes data); sent at startup
 *   0x32 0xEC  – double state record (52 = 2×26 bytes); R1=prev, R2=current
 *   0x32 0x31  – identity: null-terminated ASCII PCB model strings
 *                 "SAA41263925" (main control PCB), "SAA41261020" (inverter PCB)
 *   0x32 0x72  – short event (3 bytes); 0x0066/0x0067 at cycle start,
 *                 0x0000 near cycle end (HYPOTHESIS: door lock/unlock events)
 *   0x32 0xD8  – single-byte event; 0x02 observed near end of cycle
 *   0x32 0x00  – ack/response
 *
 * 26-byte state record layout (0-indexed within the record):
 *   [0..1]  00 18      constant header
 *   [2]     state      0=off/done  1=standby  2=running  3=running(heat)  4=standby  5=finishing
 *   [3]     sub        cycle phase: 0=none  2=washing  3=rinsing  4=drying  5=finishing
 *   [4]     00         constant
 *   [5..6]  v1         BE u16: initial cycle duration in minutes (18 for quick wash;
 *                              0x0335=821 is a sentinel value when no program is selected)
 *   [7]     counter    sequence/step byte; 05 in standby, 06 while running
 *   [8]     00         constant
 *   [9..10] remaining  BE u16: remaining cycle time in minutes (counts down from v1 to 0)
 *   [11..12] 00 00     constant
 *   [13]    temp       HYPOTHESIS: wash temperature in °C; 28 normal, 30 during heat burst
 *   [14]    flags      mostly 0; 4 observed briefly at cycle start
 *   [15..17] 02 02 01  constant
 *   [18..25] 00…       padding
 *
 * Double-record 32_EC packets carry (previous_state, current_state). We always
 * consume R2 (data[26..51]) as the authoritative current state. R1 is discarded.
 *
 * Observed state lifecycle (first capture, quick-wash cycle ~18 min):
 *   Standby:   state=1/4, sub=0, v1=v2=821 (sentinel — no program selected)
 *   Selected:  state=1,   sub=0, v1=v2=18  (18-min program selected, not yet started)
 *   Washing:   state=2,   sub=2, v2=18→11  (main wash, brief state=3 during heat-up)
 *   Rinsing:   state=2,   sub=3, v2=11→4
 *   Drying:    state=2,   sub=4, v2=4→1
 *   Finishing: state=5,   sub=5→0, v2=1
 *   Done:      state=0,   sub=0
 */

// Remaining time sentinel: values ≥ SENTINEL_THRESHOLD indicate no program is
// selected and should be treated as "no remaining time."
const SENTINEL_THRESHOLD = 200

const STATUS_OFF = 'off'
const STATUS_STANDBY = 'standby'
const STATUS_WASHING = 'washing'
const STATUS_RINSING = 'rinsing'
const STATUS_DRYING = 'drying'
const STATUS_RUNNING = 'running'
const STATUS_FINISHING = 'finishing'

export default class Device extends HADevice {
    private state: number = -1
    private sub: number = -1
    private duration: number = 0
    private remaining: number = 0
    private temp: number = 0

    private lastStatus: string = ''
    private lastDuration: number = -1
    private lastRemaining: number = -1
    private lastTemp: number = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq.id)
        thinq.on('data', (data: Buffer) => this.processData(data))

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dishwasher' }),
            components: {
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    name: 'Status',
                    icon: 'mdi:dishwasher',
                    device_class: 'enum',
                    options: [
                        STATUS_OFF,
                        STATUS_STANDBY,
                        STATUS_RUNNING,
                        STATUS_WASHING,
                        STATUS_RINSING,
                        STATUS_DRYING,
                        STATUS_FINISHING,
                    ],
                    state_topic: '$this/status-',
                },
                duration: {
                    platform: 'sensor',
                    unique_id: '$deviceid-duration',
                    name: 'Program duration',
                    icon: 'mdi:timer-sand',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    state_class: 'measurement',
                    state_topic: '$this/duration-',
                },
                remaining: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    state_class: 'measurement',
                    state_topic: '$this/remaining-',
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    name: 'Water temperature',
                    icon: 'mdi:thermometer-water',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    state_class: 'measurement',
                    state_topic: '$this/temperature-',
                    entity_category: 'diagnostic',
                },
            },
        })

        this.setConfig(config)
    }

    processData(buf: Buffer) {
        if (buf.length < 6) return
        if (buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) return
        if (buf[1] !== buf.length) return

        const cmd = (buf[2] << 8) | buf[3]
        // data = buf[4 .. len-3] (excludes 4-byte header and crc+BB)
        const data = buf.subarray(4, buf.length - 2)

        if (cmd === 0x32eb && data.length >= 26) {
            this.processRecord(data.subarray(0, 26))
        } else if (cmd === 0x32ec && data.length >= 52) {
            // R2 (bytes 26..51 of data) is the current state; R1 is the previous state.
            this.processRecord(data.subarray(26, 52))
        }
        // 0x3231 (identity), 0x3272 (events), 0x32d8, 0x3200: logged but not decoded.
    }

    private processRecord(r: Buffer) {
        if (r.length < 26) return

        this.state = r[2]
        this.sub = r[3]
        this.duration = r.readUInt16BE(5)
        this.remaining = r.readUInt16BE(9)
        this.temp = r[13]

        log('status', this.id, `state=${this.state} sub=${this.sub} duration=${this.duration} remaining=${this.remaining} temp=${this.temp}`)
        this.publishState()
    }

    private computeStatus(): string {
        switch (this.state) {
            case 0:
                return STATUS_OFF
            case 1:
            case 4:
                return STATUS_STANDBY
            case 2:
            case 3: // brief heat-up state, functionally same as running
                switch (this.sub) {
                    case 2:
                        return STATUS_WASHING // HYPOTHESIS: main wash phase
                    case 3:
                        return STATUS_RINSING // HYPOTHESIS: rinse phase
                    case 4:
                        return STATUS_DRYING // HYPOTHESIS: drying/final-rinse phase
                    default:
                        return STATUS_RUNNING
                }
            case 5:
                return STATUS_FINISHING
            default:
                return STATUS_OFF
        }
    }

    // Returns remaining minutes. Sentinel values (≥ SENTINEL_THRESHOLD, meaning
    // no program selected) and done states are reported as 0.
    private computeRemaining(): number {
        if (this.state === 0 || this.state === 4) return 0
        if (this.remaining >= SENTINEL_THRESHOLD) return 0
        return this.remaining
    }

    private computeDuration(): number {
        if (this.duration >= SENTINEL_THRESHOLD) return 0
        return this.duration
    }

    private publishState() {
        const status = this.computeStatus()
        const duration = this.computeDuration()
        const remaining = this.computeRemaining()

        if (
            status === this.lastStatus &&
            duration === this.lastDuration &&
            remaining === this.lastRemaining &&
            this.temp === this.lastTemp
        )
            return

        this.lastStatus = status
        this.lastDuration = duration
        this.lastRemaining = remaining
        this.lastTemp = this.temp

        this.HA.publishProperty(this.id, 'status-', status)
        this.HA.publishProperty(this.id, 'duration-', duration)
        this.HA.publishProperty(this.id, 'remaining-', remaining)
        if (this.temp > 0) this.HA.publishProperty(this.id, 'temperature-', this.temp)
    }

    setProperty(_prop: string, _value: string) {
        // No writable properties — dishwasher control is not supported yet.
    }
}
