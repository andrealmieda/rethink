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
 *   0x32 0x72  – short event (3 bytes); 0x0066/0x0067 at cycle start, 0x0000 at
 *                 cycle end. CONFIRMED 2026-08-11 against the official lg_thinq HA
 *                 integration on the same physical device: 0x0066 lines up with its
 *                 `notification` event + status->running at cycle start, and 0x0000
 *                 lines up with its second `notification` event + status->end.
 *   0x32 0xD8  – single-byte event, fires AT phase-transition boundaries (not just
 *                 "near end") - CONFIRMED 2026-08-11: 0x0d fired exactly at a
 *                 rinsing->drying transition (0x02 was previously seen near a
 *                 finishing transition). Value may select a buzzer/chime sound
 *                 (the official integration exposes a `chime_sound` entity) rather
 *                 than identify the transition itself - unconfirmed.
 *   0x32 0x00  – ack/response
 *
 * 26-byte state record layout (0-indexed within the record):
 *   [0..1]  00 18      constant header
 *   [2]     state      0=off/done  1=standby(door closed)  2=running  3=running(heat)
 *                              4=door open  5=finishing. CONFIRMED 2026-08-16 via a
 *                              live open/close test while in standby: state flipped
 *                              1->4 the instant the door opened and back 4->1 the
 *                              instant it closed, with v1/remaining unchanged
 *                              throughout (both still the 821 sentinel). This
 *                              retroactively explains the previously-unexplained
 *                              one-frame state=4 transient seen during the Auto
 *                              cycle's finishing sequence (2026-08-12 capture,
 *                              documented below) - many dishwashers auto-crack the
 *                              door at the end of a cycle to vent steam for drying,
 *                              which would produce exactly that signal. Whether the
 *                              door opening mid-wash (not just in standby) behaves
 *                              the same way is still unconfirmed.
 *   [3]     sub        cycle phase: 0=none  2=washing(?)  3=rinsing  4=drying  5=finishing
 *   [4]     00         constant
 *   [5..6]  v1         BE u16: initial cycle duration in minutes for fixed-length
 *                              programs (18 for quick wash; 0x0335=821 is a sentinel
 *                              when no program is selected). CORRECTED 2026-08-12:
 *                              does NOT hold for adaptive/soil-sensing programs (a
 *                              live "Auto" cycle showed v1=791, remaining live-jumping
 *                              768->571 mid-wash rather than counting down smoothly) -
 *                              so this field is actually the fixed program's declared
 *                              duration OR an adaptive program's evolving estimate,
 *                              and the two aren't distinguishable from this byte
 *                              alone. The sentinel check below is now gated to
 *                              standby only, since ≥200 here turned out to be a
 *                              legitimate in-progress Auto value, not just the 821
 *                              "no program" placeholder.
 *   [7]     counter    sequence/step byte - HYPOTHESIS revised 2026-08-12: originally
 *                              "05 standby, 06 running" from the quick-wash capture,
 *                              but an Auto cycle held this at 1 for its entire ~95 min
 *                              observed stretch (still running) - so it's evidently
 *                              program-dependent, not a universal standby/running flag.
 *                              CONFIRMED 2026-08-16: in standby it flips 5 (door
 *                              closed) <-> 0 (door open) in lockstep with state 1<->4 -
 *                              so at least in standby this tracks the door too, in
 *                              addition to/instead of "sequence/step".
 *   [8]     00         constant
 *   [9..10] remaining  BE u16, counts down from v1 - for fixed-length programs this is
 *                              literally minutes; CORRECTED 2026-08-12 for Auto: ticks
 *                              down ~1 unit/real-minute most of the time but also jumps
 *                              non-monotonically (768->571 in one step) as the machine's
 *                              soil sensor revises its estimate, and doesn't convert to
 *                              real minutes by any fixed ratio we could find (cross-
 *                              checked against the official lg_thinq integration's own
 *                              absolute finish-time: ~3.9x off near cycle start, ~3.26x
 *                              off after the jump - inconsistent, so no known formula).
 *   [11..12] 00 00     constant
 *   [13]    temp       HYPOTHESIS: wash temperature in °C; 28 normal, 30 during heat
 *                              burst (quick-wash capture) - held at a constant 20 for
 *                              the entire Auto cycle observed 2026-08-12, no heat burst
 *   [14]    flags      CORRECTED 2026-08-12: NOT "mostly 0, briefly 4 at cycle start" -
 *                              an Auto cycle held this at 4 continuously for its entire
 *                              ~95 min observed stretch, so "briefly" doesn't hold
 *                              universally either; still don't know what it signals
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
 *
 * Second capture (2026-08-11, official "Rinse" program, 18 min, cross-checked live
 * against the official lg_thinq HA integration on the same device): every sub
 * transition instant lined up exactly with the official integration's own
 * current_status changes - sub 2->3 with its running->rinsing, sub 3->4 with its
 * rinsing->drying, state 5 with its ->end. That CONFIRMS sub=3/4 and state=5 as real
 * phase boundaries. sub=2 stays the one open question: the official status for that
 * stretch is just the generic "running" (no wash-specific term) - not surprising
 * since "Rinse" is a rinse-only program, so it's still unclear whether sub=2 means
 * literal detergent washing or just "the machine's first active/fill phase",
 * generic across programs. See computeStatus()'s STATUS_WASHING for where this
 * assumption lives.
 *
 * Third capture (2026-08-12, the same Auto/soil-sensing cycle from above, followed
 * through to completion): the finishing sequence generalizes past the quick-wash
 * case - Drying (state=2,sub=4) -> Finishing (state=5,sub=5) -> a one-frame
 * transient state=4,sub=0 (NEW: state=4 isn't exclusively a standby marker; here it
 * appears for a single frame during shutdown) -> Done (state=0,sub=0). v1 stayed at
 * 791 unchanged through every one of those frames, including the final state=0 one -
 * the device never resets it itself even at the very end of a long adaptive cycle,
 * confirming computeDuration()'s explicit state===0 reset is required in general, not
 * just for the quick-wash capture it was first observed in. Separately, temp cooled
 * 22->20 during drying/finishing (no spike at shutdown) - contrasts with a brief
 * 20->28->20 heat-burst spike seen mid-cycle during rinsing in this same run, so the
 * heat burst looks tied to a specific wash/rinse sub-phase rather than to shutdown.
 * Also saw a new 0x32d8 event value (0x0f; previously only 0x0d and 0x02 observed) -
 * logged, meaning still unconfirmed. The v1/remaining-to-real-minutes ratio for Auto
 * mode is still unresolved: this capture started mid-cycle (v1 already at 791 by the
 * first sample), so there's no true wire-vs-wall-clock baseline from cycle start to
 * derive a formula from.
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
    private door: boolean = false

    private lastStatus: string = ''
    private lastDuration: number = -1
    private lastRemaining: number = -1
    private lastTemp: number = -1
    private lastDoor: boolean = false

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
        this.door = this.state === 4

        log(
            'status',
            this.id,
            `state=${this.state} sub=${this.sub} duration=${this.duration} remaining=${this.remaining} temp=${this.temp}`,
        )
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

    // Standby (no cycle running): state 1 is standby with the door closed; state 4 is
    // the same standby but with the door open (confirmed 2026-08-16 - see doc header).
    private isStandby(): boolean {
        return this.state === 1 || this.state === 4
    }

    // Returns remaining minutes. Sentinel values (≥ SENTINEL_THRESHOLD, meaning no
    // program selected) and done states are reported as 0. The sentinel check only
    // applies in standby - CORRECTED 2026-08-12: a live Auto cycle legitimately read
    // ≥200 while actively running, so "no program selected" can't be inferred from
    // magnitude alone once a cycle has actually started.
    private computeRemaining(): number {
        if (this.state === 0 || this.state === 4) return 0
        if (this.isStandby() && this.remaining >= SENTINEL_THRESHOLD) return 0
        return this.remaining
    }

    private computeDuration(): number {
        // Mirror computeRemaining()'s off-state reset: the real device does NOT clear
        // v1 on its own when a cycle finishes (confirmed by DONE_HEX below, state=0 but
        // v1 still 18) - without this the sensor would stick at the last cycle's length.
        if (this.state === 0) return 0
        if (this.isStandby() && this.duration >= SENTINEL_THRESHOLD) return 0
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
            this.temp === this.lastTemp &&
            this.door === this.lastDoor
        )
            return

        this.lastStatus = status
        this.lastDuration = duration
        this.lastRemaining = remaining
        this.lastTemp = this.temp
        this.lastDoor = this.door

        this.HA.publishProperty(this.id, 'status-', status)
        this.HA.publishProperty(this.id, 'duration-', duration)
        this.HA.publishProperty(this.id, 'remaining-', remaining)
        if (this.temp > 0) this.HA.publishProperty(this.id, 'temperature-', this.temp)
        this.HA.publishProperty(this.id, 'door-', this.door ? 'ON' : 'OFF')
    }

    setProperty(_prop: string, _value: string) {
        // No writable properties — dishwasher control is not supported yet.
    }
}
