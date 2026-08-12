import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'

/**
 * LG Steam Oven
 * Physical model: WS7D7631WB
 * ThinQ kind:     WSED7613S
 * Platform:       ThinQ2, custom binary protocol (NOT TLV)
 *
 * Frame format:  AA <totalLen> <cmd1> <cmd2> <data…> <crc8> BB
 *
 * Packet types (device → cloud, cmd1=0x40):
 *   0x40 0xEB  – single state record (115 bytes data); sent at startup
 *   0x40 0xEC  – double state record (230 = 2×115 bytes); R1=prev, R2=current
 *   0x40 0x72  – event notification
 *   0x40 0x00  – ack/response
 *
 * 115-byte state record layout (0-indexed within record):
 *   [0..13]  00 00 01 00 00 01 02 00 FF 03 00 02 00 00  constant header
 *   [14]     state      0=off  1=cooking  2=stopping/finishing
 *   [15]     mode       0x81 while timer is active, 0x00 otherwise
 *   [16]     seconds    countdown seconds (0–59)
 *   [17]     minutes    countdown minutes
 *   [18]     00         constant
 *   [19]     set_min    set timer duration in minutes (fixed during a cook)
 *   [20]     00         constant
 *   [21]     0x80       heat-element active flag (0x80=on, 0x00=off)
 *   [22]     set_temp   target temperature °C  (e.g. 0x1E=30°C for steam-proof mode)
 *   [23]     00         constant
 *   [24]     cur_temp   actual oven temperature °C (rises from ambient toward set_temp)
 *   [25..30] 00…        constant
 *   [31]     amb_temp   ambient/residual thermistor reading (retained even when off);
 *                       decays toward true room temp after a cook (e.g. 30 right after
 *                       a 30°C cook stops, cooling to 19, then 17 during a longer idle)
 *   [32..]   00…        padding
 *
 * Double-record 40_EC packets carry (previous_state, current_state). We always
 * consume R2 (data[115..229]) as the authoritative current state.
 *
 * Observed lifecycle (WS7D7631WB, 15-min steam-proof at 30°C):
 *   Off:      state=0, everything zero except amb_temp
 *   Cooking:  state=1, timer counts down from set_min:00, cur_temp rises toward set_temp
 *   Stopping: state=2 (brief), seen in R1 when R2 already shows state=0
 *   Done:     state=0, all cooking fields zero
 */

export default class Device extends HADevice {
    private state: number = -1
    private seconds: number = 0
    private minutes: number = 0
    private setMin: number = 0
    private setTemp: number = 0
    private curTemp: number = 0
    private ambTemp: number = 0

    private lastStatus: string = ''
    private lastRemaining: number = -1
    private lastSetMin: number = -1
    private lastSetTemp: number = -1
    private lastCurTemp: number = -1
    private lastAmbTemp: number = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq.id)
        thinq.on('data', (data: Buffer) => this.processData(data))

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Steam Oven' }),
            components: {
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    name: 'Status',
                    icon: 'mdi:toaster-oven',
                    device_class: 'enum',
                    options: ['off', 'on'],
                    state_topic: '$this/status-',
                },
                remaining: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                    state_topic: '$this/remaining-',
                },
                set_timer: {
                    platform: 'sensor',
                    unique_id: '$deviceid-set-timer',
                    name: 'Set timer',
                    icon: 'mdi:timer-sand',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    state_class: 'measurement',
                    state_topic: '$this/set_timer-',
                },
                set_temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-set-temperature',
                    name: 'Set temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    state_class: 'measurement',
                    state_topic: '$this/set_temperature-',
                },
                temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temperature',
                    name: 'Current temperature',
                    icon: 'mdi:thermometer-water',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    state_class: 'measurement',
                    state_topic: '$this/temperature-',
                    entity_category: 'diagnostic',
                },
                ambient_temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-ambient-temperature',
                    name: 'Ambient temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    state_class: 'measurement',
                    state_topic: '$this/ambient_temperature-',
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
        const data = buf.subarray(4, buf.length - 2)

        if (cmd === 0x40eb && data.length >= 115) {
            this.processRecord(data.subarray(0, 115))
        } else if (cmd === 0x40ec && data.length >= 230) {
            this.processRecord(data.subarray(115, 230))
        }
    }

    private processRecord(r: Buffer) {
        if (r.length < 32) return

        this.state = r[14]
        this.seconds = r[16]
        this.minutes = r[17]
        this.setMin = r[19]
        this.setTemp = r[22]
        this.curTemp = r[24]
        this.ambTemp = r[31]

        log(
            'status',
            this.id,
            `state=${this.state} remaining=${this.minutes}m${this.seconds}s setMin=${this.setMin} setTemp=${this.setTemp} curTemp=${this.curTemp}`,
        )
        this.publishState()
    }

    private computeStatus(): string {
        return this.state === 0 ? 'off' : 'on'
    }

    private computeRemaining(): number {
        if (this.state === 0) return 0
        return Math.round((this.minutes + this.seconds / 60) * 100) / 100
    }

    private publishState() {
        const status = this.computeStatus()
        const remaining = this.computeRemaining()

        if (
            status === this.lastStatus &&
            remaining === this.lastRemaining &&
            this.setMin === this.lastSetMin &&
            this.setTemp === this.lastSetTemp &&
            this.curTemp === this.lastCurTemp &&
            this.ambTemp === this.lastAmbTemp
        )
            return

        this.lastStatus = status
        this.lastRemaining = remaining
        this.lastSetMin = this.setMin
        this.lastSetTemp = this.setTemp
        this.lastCurTemp = this.curTemp
        this.lastAmbTemp = this.ambTemp

        this.HA.publishProperty(this.id, 'status-', status)
        this.HA.publishProperty(this.id, 'remaining-', remaining)
        this.HA.publishProperty(this.id, 'set_timer-', this.setMin)
        if (this.setTemp > 0) this.HA.publishProperty(this.id, 'set_temperature-', this.setTemp)
        if (this.curTemp > 0) this.HA.publishProperty(this.id, 'temperature-', this.curTemp)
        if (this.ambTemp > 0) this.HA.publishProperty(this.id, 'ambient_temperature-', this.ambTemp)
    }

    setProperty(_prop: string, _value: string) {
        // No writable properties yet.
    }
}
