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
 *   0x40 0xEB  – single state record (115 bytes data); sent at startup, and also
 *                 whenever the physical "Remote Start" button is pressed (confirmed
 *                 live 2026-08-12) - byte-identical to the idle baseline either way.
 *                 That button press doesn't touch anything in the state record; the
 *                 cloud reacts to it with an unrelated 0xF0 0xED capability-list
 *                 command (cmd1=0xf0, a generic cross-device session channel, not
 *                 part of this state protocol), so the "remote enabled" flag is
 *                 session state on the cloud side, not appliance telemetry.
 *   0x40 0xEC  – double state record (230 = 2×115 bytes); R1=prev, R2=current
 *   0x40 0x31  – identity: null-terminated ASCII PCB model string ("SAA43884301"
 *                 confirmed live 2026-08-12) followed by binary telemetry, sent at
 *                 startup alongside the first 0x40EB
 *   0x40 0x72  – event notification
 *   0x40 0x00  – ack/response - CONFIRMED 2026-08-12 as the device's ack for any
 *                 0xF0-family command (see below), echoing that command's cmd2 byte
 *                 back as its 1-byte payload
 *
 * Packet types (cloud -> device, cmd1=0xF0 - the same generic cross-device session
 * channel as the Remote Start handshake, not part of this device's own 0x40 family):
 *   0xF0 0x43  – start a cook. Payload: `20 0b 18 00 00 00 01 00 <temp> 00 <min> 00
 *                 00 00 00 00 00` (17 data bytes). CONFIRMED across two live air-fry
 *                 starts 2026-08-12 - 200C/15min and 170C/20min - which differed in
 *                 ONLY the temp byte (offset 8, raw = whole degrees C) and minutes
 *                 byte (offset 10, raw = whole minutes); every other byte was
 *                 identical between the two. buildStartCommand() below builds this
 *                 for arbitrary temp/minutes. STILL UNCONFIRMED: whether byte 0
 *                 (0x20 in both samples) is a function selector that would need to
 *                 change for steam-proof or another mode - we only have air-fry
 *                 samples so far, so this command is air-fry only until a
 *                 steam-proof (or other function) start is captured for comparison.
 *   0xF0 0x44  – stop the current cook. CONFIRMED 2026-08-12: payload is a single
 *                 0x00 byte.
 *
 * 115-byte state record layout (0-indexed within record):
 *   [0..13]  00 00 01 00 00 01 02 00 FF 03 00 02 00 00  constant header
 *   [14]     state      0=off  1=cooking (steam-proof)  2=cooking (air fry) or a
 *                        brief transitional state at stop - CORRECTED 2026-08-12: a
 *                        live air-fry run held state=2 continuously for its entire
 *                        ~15 min duration, not just briefly "stopping/finishing" as
 *                        previously documented from a single steam-proof capture.
 *                        state ties to `mode` (below) to tell functions apart.
 *   [15]     mode       0x81 while a steam-proof timer is active, 0x98 while an air
 *                        fry timer is active (CONFIRMED 2026-08-12), 0x00 otherwise -
 *                        i.e. this is a function selector, not just an "is running"
 *                        flag as previously documented
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
 *   Cooking:  state=1, mode=0x81, timer counts down from set_min:00, cur_temp rises
 *             toward set_temp
 *   Stopping: state=2 (brief), seen in R1 when R2 already shows state=0
 *   Done:     state=0, all cooking fields zero
 *
 * Second/third lifecycle (2026-08-12, remote-started air fry via 0xF043 - 200C/15min,
 * then separately 170C/20min):
 *   Cooking:  state=2, mode=0x98, timer counts down from set_min:00 - cur_temp stayed
 *             0 for the ENTIRE run both times (unlike the steam-proof capture, where
 *             it rose toward set_temp) - open question, not yet explained
 *   Stopped early via 0xF044 partway through the first timer -> state=0 immediately,
 *   same as a natural completion
 */

// Fixed bytes of the 0xF0 0x43 start-cook payload, confirmed identical across both
// air-fry samples (200C/15min and 170C/20min) - see the doc note above. `null`
// marks where temp/minutes go.
const START_COOKING_TEMPLATE: (number | null)[] = [
    0x20,
    0x0b,
    0x18,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    null,
    0x00,
    null,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
]
const STOP = 'F04400'

export default class Device extends HADevice {
    private state: number = -1
    private seconds: number = 0
    private minutes: number = 0
    private setMin: number = 0
    private setTemp: number = 0
    private curTemp: number = 0
    private ambTemp: number = 0

    // Staged start parameters (air fry only - see doc note above), settable from HA
    // before pressing Start, mirroring the ThinQ app's set-then-start flow. Defaults
    // to the first confirmed sample.
    private startTemp: number = 200
    private startMinutes: number = 15

    private lastStatus: string = ''
    private lastRemaining: number = -1
    private lastSetMin: number = -1
    private lastSetTemp: number = -1
    private lastCurTemp: number = -1
    private lastAmbTemp: number = -1

    constructor(
        HA: Connection,
        private readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data: Buffer) => this.processData(data))

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Steam Oven' }),
            components: {
                start_temperature: {
                    platform: 'number',
                    unique_id: '$deviceid-start-temperature',
                    name: 'Air fry start temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    // Sane UI bounds around the two confirmed samples (170, 200) -
                    // not confirmed hardware limits.
                    min: 40,
                    max: 230,
                    step: 5,
                    state_topic: '$this/start_temperature-',
                    command_topic: '$this/start_temperature/set',
                },
                start_duration: {
                    platform: 'number',
                    unique_id: '$deviceid-start-duration',
                    name: 'Air fry start duration',
                    icon: 'mdi:timer-sand',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    min: 1,
                    max: 180,
                    step: 1,
                    state_topic: '$this/start_duration-',
                    command_topic: '$this/start_duration/set',
                },
                start: {
                    platform: 'button',
                    unique_id: '$deviceid-start',
                    name: 'Start air fry',
                    icon: 'mdi:play-circle-outline',
                    command_topic: '$this/start/set',
                    payload_press: '',
                },
                stop: {
                    platform: 'button',
                    unique_id: '$deviceid-stop',
                    name: 'Stop',
                    icon: 'mdi:stop-circle-outline',
                    command_topic: '$this/stop/set',
                    payload_press: '',
                },
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
        this.HA.publishProperty(this.id, 'start_temperature-', this.startTemp)
        this.HA.publishProperty(this.id, 'start_duration-', this.startMinutes)
    }

    processData(buf: Buffer) {
        if (buf.length < 6) return
        if (buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) return
        if (buf[1] !== buf.length) return

        const cmd = (buf[2] << 8) | buf[3]
        const data = buf.subarray(4, buf.length - 2)

        if (cmd === 0x40eb && data.length >= 115) {
            // 0x40EB (single record) fires both at real startup and whenever the
            // physical "Remote Start" button is pressed - confirmed live 2026-08-12:
            // pressing it re-sent this exact frame (byte-identical to the idle
            // baseline) and the cloud replied with an unrelated 0xF0ED capability-list
            // command. The button doesn't flip any bit in the oven's own state record;
            // it re-authorizes a session at the protocol/cloud level instead, so this
            // is the only local signal we have that it was pressed.
            log('event', this.id, 'device (re-)announced (startup, or Remote Start button pressed)')
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

    setProperty(prop: string, value: string) {
        if (prop === 'start_temperature') {
            this.startTemp = Number(value)
            this.HA.publishProperty(this.id, 'start_temperature-', this.startTemp)
        } else if (prop === 'start_duration') {
            this.startMinutes = Number(value)
            this.HA.publishProperty(this.id, 'start_duration-', this.startMinutes)
        } else if (prop === 'start') {
            this.send(this.buildStartCommand(this.startTemp, this.startMinutes))
        } else if (prop === 'stop') {
            this.send(Buffer.from(STOP, 'hex'))
        }
    }

    // Builds the 0xF0 0x43 start-cook command for arbitrary temp (whole °C) /
    // minutes, from the template confirmed across two air-fry samples. Air fry
    // only - see the doc note on 0xF0 0x43 above.
    private buildStartCommand(tempC: number, minutes: number): Buffer {
        const data = START_COOKING_TEMPLATE.map((b, i) => {
            if (b !== null) return b
            return i === 8 ? tempC & 0xff : minutes & 0xff
        })
        return Buffer.concat([Buffer.from([0xf0, 0x43]), Buffer.from(data)])
    }

    // AA <len> <inner> <checksum> BB framing, verified against real captures of both
    // the 0x40-family (device->cloud) and 0xF0-family (cloud->device) packets: len
    // is inner.length+4, and checksum is (sum of every byte from AA through the
    // trailing 00 00 placeholder, inclusive) & 0xff, XORed with 0x55.
    private send(inner: Buffer) {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])])
        const sum = packet.reduce((pv, cv) => pv + cv, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        packet[packet.length - 1] = 0xbb
        this.thinq.send_packet(packet)
    }
}
