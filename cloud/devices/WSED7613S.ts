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
 *   0x40 0x72  – event notification, 13 data bytes `<b0> <flag> 0a 00...00`.
 *                 CONFIRMED 2026-08-12: flag=0x01 fires exactly when cur_temp first
 *                 reaches set_temp during a top/bottom-heat preheat (matches the
 *                 oven's own audible chime) - state flips 1->2 in the very next
 *                 record at the same instant. flag=0x10 seen once, much earlier,
 *                 meaning unconfirmed.
 *   0x40 0x00  – ack/response - CONFIRMED 2026-08-12 as the device's ack for any
 *                 0xF0-family command (see below), echoing that command's cmd2 byte
 *                 back as its 1-byte payload
 *
 * Packet types (cloud -> device, cmd1=0xF0 - the same generic cross-device session
 * channel as the Remote Start handshake, not part of this device's own 0x40 family):
 *   0xF0 0x43  – start a cook, OR update temp/time on an already-running one (same
 *                 command works for both - confirmed live 2026-08-12 by adjusting a
 *                 running top/bottom-heat cook from 170C/15min to 190C/20min with a
 *                 second 0xF043). Payload: `20 0b <func> 00 00 00 01 00 <temp> 00
 *                 <min> 00 00 00 00 00 00` (17 data bytes). CONFIRMED across four
 *                 live starts 2026-08-12 (air fry 200C/15min, air fry 170C/20min,
 *                 top/bottom-heat 170C/15min, top/bottom-heat 190C/20min - the last
 *                 being the running-adjustment case): <func> (offset 2) is
 *                 0x18=air fry, 0x03=top/bottom heat; <temp> (offset 8, whole °C)
 *                 and <min> (offset 10, whole minutes) vary independently; every
 *                 other byte was identical across all four. buildStartCommand()
 *                 below builds this for any (func, temp, minutes). Only these two
 *                 functions are confirmed - others (steam-proof, grill, etc.) may
 *                 use different <func> values we haven't captured yet.
 *   0xF0 0x44  – stop the current cook. CONFIRMED 2026-08-12: payload is a single
 *                 0x00 byte.
 *   0xF0 0xED  – capability-list push, normally sent by the cloud automatically in
 *                 reaction to a 0x40EB re-announce (see above) - but CONFIRMED live
 *                 2026-08-12 (reproduced 4 times) that replaying it on demand also
 *                 reliably makes the device send back a fresh 0x40EB, i.e. it
 *                 doubles as a query command that reads current state without
 *                 starting a cook. Important caveat, also confirmed live: this (and
 *                 every other 0xF0-family command, even the already-live 0xF044
 *                 stop) gets silently dropped - no ack, no response at all - when
 *                 the appliance's WiFi has gone idle-to-sleep, which happens after
 *                 some period with no activity; it only works while the appliance
 *                 is actually connected. Physical activity at the oven (confirmed:
 *                 opening the door) wakes it back up - NOT specifically a "Remote
 *                 Start" session as first suspected; that was a wrong theory from
 *                 an earlier round of testing that happened to coincide with a
 *                 button press. The constructor pings REFRESH_QUERY every 2
 *                 minutes as an attempted keepalive - CONFIRMED live 2026-08-12
 *                 this does NOT prevent the sleep: 4 consecutive pings 2 minutes
 *                 apart all went unanswered once the device decided to sleep, so
 *                 the sleep timer is anchored to something else (real activity?),
 *                 not to incoming traffic. sendKeepalive()/`awake` below exist so
 *                 we stop spamming pings once one goes unanswered, rather than to
 *                 actually keep the connection alive - pinging resumes
 *                 automatically the moment the device shows any sign of life on
 *                 its own.
 *
 * 115-byte state record layout (0-indexed within record):
 *   [0..13]  00 00 01 00 00 01 02 00 FF 03 00 02 00 00  constant header
 *   [14]     state      0=off; 1=preheating/running; 2=at temperature (once cur_temp
 *                        reaches set_temp - CONFIRMED 2026-08-12 via a top/bottom
 *                        heat preheat, causally tied to the 0x4072 flag=0x01 event
 *                        below) or a brief transitional state at stop. `mode`, not
 *                        `state`, is what identifies which function is running -
 *                        CORRECTED 2026-08-12: a live air-fry run held state=2
 *                        continuously for its entire ~15 min duration (it may not
 *                        have a distinct preheat phase, or reports it differently -
 *                        cur_temp stayed 0 throughout), not just briefly
 *                        "stopping/finishing" as previously documented from a single
 *                        steam-proof capture.
 *   [15]     mode       function selector while a timer is active, 0x00 otherwise -
 *                        CONFIRMED 2026-08-12: 0x81=steam-proof, 0x83=top/bottom
 *                        heat, 0x98=air fry. Not the same byte values as the 0xF043
 *                        command's own <func> selector (0x18/0x03) - this is a
 *                        separate enum in the state record.
 *   [16]     seconds    countdown seconds (0–59)
 *   [17]     minutes    countdown minutes
 *   [18]     00         constant
 *   [19]     set_min    set timer duration in minutes (fixed during a cook)
 *   [20]     00         constant
 *   [21]     0x80       heat-element active flag (0x80=on, 0x00=off)
 *   [22]     set_temp   target temperature °C  (e.g. 0x1E=30°C for steam-proof mode)
 *   [23]     00         constant
 *   [24]     cur_temp   actual oven temperature °C (rises from ambient toward set_temp)
 *   [25..26] 00…        constant
 *   [27]     flags      bit 0x04 = door open - CONFIRMED 2026-08-12 twice (once
 *                        during an active cook, once while idle): sets for exactly
 *                        the few seconds the door is physically open, clears on
 *                        close. bit 0x20 = seen set only while actively cooking
 *                        (baseline 0x20 running / 0x00 idle, independent of the
 *                        door bit) - HYPOTHESIS, meaning otherwise unconfirmed. The
 *                        oven's fan is audible even while state=0 (off) but produces
 *                        no change anywhere in this record or any new packet, same
 *                        as the light - neither appears to round-trip through this
 *                        protocol at all.
 *   [28..30] 00…        constant
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
 *
 * Fourth lifecycle (2026-08-12, remote-started top/bottom heat via 0xF043 at
 * 170C/15min, then adjusted mid-run to 190C/20min with a second 0xF043):
 *   Preheating: state=1, mode=0x83, cur_temp rising toward set_temp (this function
 *   does report a rising cur_temp, unlike air fry) - the mid-run adjustment took
 *   effect without a stop/restart.
 *   At temperature: the moment cur_temp==set_temp, a 0x4072 event (flag=0x01) fires
 *   and state flips 1->2 in the same instant - state=2 here means "at temperature",
 *   not "air fry" as in the second lifecycle; it's a shared preheat/cook phase
 *   marker, and `mode` is what actually identifies the function.
 */

// Cooking functions confirmed for the 0xF0 0x43 command's <func> byte (offset 2) -
// see the doc note above. Only these two are confirmed; others may exist.
const COOKING_FUNCTIONS = {
    air_fry: 0x18,
    top_bottom_heat: 0x03,
} as const
type CookingFunction = keyof typeof COOKING_FUNCTIONS

// Fixed bytes of the 0xF0 0x43 start-cook payload, confirmed identical across all
// four live samples (see the doc note above). `null` marks where func/temp/minutes
// go.
const START_COOKING_TEMPLATE: (number | null)[] = [
    0x20,
    0x0b,
    null,
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

// Confirmed live 2026-08-12 to make the oven send back a fresh 0x40EB state
// snapshot without starting a cook - see the 0xF0 0xED doc note above.
const REFRESH_QUERY = 'F0ED114101000000181A1017181C272E2F33505356595C00000000000000000000000000'

// How long to wait for a reply to a keepalive query before assuming the
// appliance's WiFi has gone to sleep and pausing further pings.
const KEEPALIVE_REPLY_TIMEOUT_MS = 10 * 1000
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000

export default class Device extends HADevice {
    private state: number = -1
    private seconds: number = 0
    private minutes: number = 0
    private setMin: number = 0
    private setTemp: number = 0
    private curTemp: number = 0
    private ambTemp: number = 0
    private door: boolean = false

    // Keepalive bookkeeping: CONFIRMED live 2026-08-12 that pinging on a fixed
    // interval does NOT keep the appliance's WiFi awake - it went to sleep on its
    // own schedule regardless, ignoring 4 consecutive pings sent 2 minutes apart.
    // So instead of blindly pinging forever, we track whether the last query
    // actually got a reply and stop sending more once it doesn't - `awake` flips
    // back to true (and pinging resumes) the moment the device shows any sign of
    // life on its own (a real incoming frame), which happens when something wakes
    // it up physically (confirmed: opening the door).
    private refreshInterval: ReturnType<typeof setInterval> | undefined
    private keepaliveReplyTimeout: ReturnType<typeof setTimeout> | undefined
    private awake: boolean = true

    // Staged start parameters, settable from HA before pressing Start (or while
    // already running - the same command updates a live cook), mirroring the ThinQ
    // app's set-then-start flow. Defaults to the first confirmed sample.
    private startFunction: CookingFunction = 'air_fry'
    private startTemp: number = 200
    private startMinutes: number = 15

    private lastStatus: string = ''
    private lastRemaining: number = -1
    private lastSetMin: number = -1
    private lastSetTemp: number = -1
    private lastCurTemp: number = -1
    private lastAmbTemp: number = -1
    private lastDoor: boolean | undefined = undefined

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
                start_function: {
                    platform: 'select',
                    unique_id: '$deviceid-start-function',
                    name: 'Start function',
                    icon: 'mdi:chef-hat',
                    options: Object.keys(COOKING_FUNCTIONS),
                    state_topic: '$this/start_function-',
                    command_topic: '$this/start_function/set',
                },
                start_temperature: {
                    platform: 'number',
                    unique_id: '$deviceid-start-temperature',
                    name: 'Start temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    // Sane UI bounds around the confirmed samples (170-200) - not
                    // confirmed hardware limits.
                    min: 40,
                    max: 230,
                    step: 5,
                    state_topic: '$this/start_temperature-',
                    command_topic: '$this/start_temperature/set',
                },
                start_duration: {
                    platform: 'number',
                    unique_id: '$deviceid-start-duration',
                    name: 'Start duration',
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
                    name: 'Start / update cook',
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
                door: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door',
                    name: 'Door',
                    device_class: 'door',
                    state_topic: '$this/door-',
                },
            },
        })

        this.setConfig(config)
        this.HA.publishProperty(this.id, 'start_function-', this.startFunction)
        this.HA.publishProperty(this.id, 'start_temperature-', this.startTemp)
        this.HA.publishProperty(this.id, 'start_duration-', this.startMinutes)

        this.refreshInterval = setInterval(() => this.sendKeepalive(), KEEPALIVE_INTERVAL_MS)
    }

    drop() {
        clearInterval(this.refreshInterval)
        clearTimeout(this.keepaliveReplyTimeout)
        super.drop()
    }

    private sendKeepalive() {
        if (!this.awake) return // already unanswered - don't spam a sleeping device
        this.send(Buffer.from(REFRESH_QUERY, 'hex'))
        this.keepaliveReplyTimeout = setTimeout(() => {
            this.awake = false
            log('event', this.id, 'keepalive query got no reply - assuming WiFi went to sleep, pausing pings')
        }, KEEPALIVE_REPLY_TIMEOUT_MS)
    }

    processData(buf: Buffer) {
        if (buf.length < 6) return
        if (buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) return
        if (buf[1] !== buf.length) return

        if (!this.awake) log('event', this.id, 'device is responding again')
        this.awake = true
        clearTimeout(this.keepaliveReplyTimeout)

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
        this.door = (r[27] & 0x04) !== 0
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
            this.ambTemp === this.lastAmbTemp &&
            this.door === this.lastDoor
        )
            return

        this.lastStatus = status
        this.lastRemaining = remaining
        this.lastSetMin = this.setMin
        this.lastSetTemp = this.setTemp
        this.lastCurTemp = this.curTemp
        this.lastAmbTemp = this.ambTemp
        this.lastDoor = this.door

        this.HA.publishProperty(this.id, 'status-', status)
        this.HA.publishProperty(this.id, 'remaining-', remaining)
        this.HA.publishProperty(this.id, 'set_timer-', this.setMin)
        if (this.setTemp > 0) this.HA.publishProperty(this.id, 'set_temperature-', this.setTemp)
        if (this.curTemp > 0) this.HA.publishProperty(this.id, 'temperature-', this.curTemp)
        if (this.ambTemp > 0) this.HA.publishProperty(this.id, 'ambient_temperature-', this.ambTemp)
        this.HA.publishProperty(this.id, 'door-', this.door ? 'ON' : 'OFF')
    }

    setProperty(prop: string, value: string) {
        if (prop === 'start_function') {
            if (value in COOKING_FUNCTIONS) {
                this.startFunction = value as CookingFunction
                this.HA.publishProperty(this.id, 'start_function-', this.startFunction)
            }
        } else if (prop === 'start_temperature') {
            this.startTemp = Number(value)
            this.HA.publishProperty(this.id, 'start_temperature-', this.startTemp)
        } else if (prop === 'start_duration') {
            this.startMinutes = Number(value)
            this.HA.publishProperty(this.id, 'start_duration-', this.startMinutes)
        } else if (prop === 'start') {
            this.send(this.buildStartCommand(this.startFunction, this.startTemp, this.startMinutes))
        } else if (prop === 'stop') {
            this.send(Buffer.from(STOP, 'hex'))
        }
    }

    // Builds the 0xF0 0x43 start/update-cook command for any confirmed function
    // (see COOKING_FUNCTIONS) and arbitrary temp (whole °C) / minutes, from the
    // template confirmed across four live samples - see the doc note on 0xF0 0x43
    // above. The same command both starts a fresh cook and updates one already
    // running.
    private buildStartCommand(func: CookingFunction, tempC: number, minutes: number): Buffer {
        const data = START_COOKING_TEMPLATE.map((b, i) => {
            if (b !== null) return b
            if (i === 2) return COOKING_FUNCTIONS[func]
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
