import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * LG Water Heater
 * Official model: WH27STR2.FA  (heat-pump water heater; device reports "WH27STR2")
 * ThinQ model:    WHT_056905_WW  (shared across the WH20/WH27 family)
 * Platform:       Thinq2, TLV protocol variant
 *
 * Tag map derived from a wire capture (wh27s, 2026-06-21). CONFIRMED tags are
 * marked; HYPOTHESIS tags are diagnostics whose exact meaning still needs a
 * cloud-correlated capture to pin down.
 *
 *   0x1f7  power            CONFIRMED  1=on / 0=off
 *   0x1f9  mode             CONFIRMED  observed values 25,26,27,28 (4 modes);
 *                                      written together with 0x256 by the app
 *   0x256  target temp      CONFIRMED  raw = 2 x °C (104->106 == 52->53 °C);
 *                                      the app SET wrote {0x1f9, 0x256} together
 *   0x255  current temp     CONFIRMED  raw = 2 x °C (measured tank temp, ~57-59 °C)
 *   0x229  temp 2           HYPOTHESIS raw/2 ~23-24 °C (ambient / air-intake?)
 *   0x221  error code       HYPOTHESIS 0 = ok (same tag the AC uses for errors)
 *   0x2b3  power draw (W)   HYPOTHESIS 0 when idle (same tag the AC uses); a
 *                                      nonzero value is a de-facto "heating now"
 *                                      signal — the official lg_thinq cloud
 *                                      integration cannot tell when the unit is
 *                                      actually running (HA core issue #160012),
 *                                      so this is a local-protocol advantage.
 *                                      Capture during a heating cycle to confirm
 *                                      and to find any dedicated compressor flag.
 *   0x188  run state enum    OPAQUE     1=idle; 3 and 5 both seen while running
 *                                      (~1978 W, ~312 W) — not used; Heating is
 *                                      derived from 0x2b3 power instead
 *   0x1ee  hot-water %?      HYPOTHESIS 100 full/idle, drops while charging (30-60)
 *   0x355  slow counter     UNKNOWN    drifts down over hours
 *   0x281  =3               IGNORE     periodic heartbeat, not user state
 *
 * Capabilities packet (reply to 0x1f5=1, frame marker buf[8]=0x01) provides:
 *   0x2da              eeprom checksum -> isCapsResponse key (same tag as the AC)
 *   0x2d7/0x2d8 pairs  supported modes: (25,26,27,28) -> confirms the mode set
 *   0x2d2=30, 0x2d8=70 min / max temperature (whole °C)
 *   0x2db=0x767601     firmware version (matches the deploy packet softVer)
 *
 * Device identity packets (header A8 66 / A8 67) embed the model string "WH27STR2"
 * and serial "507TAWMMR217" — this unit is the WH27STR2 variant of the family.
 */

// LG modes are AUTO / HEAT_PUMP / TURBO / VACATION. We expose them with the same
// HA-standard water_heater states the official `lg_thinq` integration uses, so
// dashboards/automations stay portable:
//   LG AUTO      -> 'eco'          (lg_thinq: DEVICE_OP_MODE_TO_HA 'auto' -> STATE_ECO)
//   LG HEAT_PUMP -> 'heat_pump'    (-> STATE_HEAT_PUMP)
//   LG TURBO     -> 'performance'  (-> STATE_PERFORMANCE)
//   LG VACATION  -> 'vacation'     (custom; official integration omits it)
//
// Numeric TLV codes (rethink-local; the cloud API uses the strings above).
// CONFIRMED on hardware via HA mode-change round-trips: 25 == eco, 26 == heat_pump,
// 28 == vacation (each command wrote 0x1f9=<code> and the device switched to and
// reported that mode). 27 == performance by elimination — caps enumerates exactly
// {25,26,27,28} and the other three are pinned.
const MODE_R2H: Record<number, string> = {
    25: 'eco', // LG "Auto"
    26: 'heat_pump', // LG "Heat Pump"
    27: 'performance', // LG "Turbo"
    28: 'vacation', // LG "Vacation"
}
const MODE_H2R: Record<string, number> = Object.fromEntries(Object.entries(MODE_R2H).map(([r, h]) => [h, Number(r)]))

export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Water Heater' }),
            components: {
                water_heater: {
                    platform: 'water_heater',
                    unique_id: '$deviceid-water_heater',
                    name: null,
                    temperature_unit: 'C',
                    // From the capabilities packet: 0x2d2=30 (min) and 0x2d8=70 (max),
                    // in whole °C. (The setpoint/measured tags use 2 x °C; the caps
                    // limits are direct °C.) raw step is 2 (== 1 °C).
                    min_temp: 30,
                    max_temp: 70,
                    precision: 1,
                    // No 'off': the official integration exposes water heaters as
                    // TARGET_TEMPERATURE + OPERATION_MODE only (no on/off — unlike
                    // boilers). The unit is effectively always-on; 'vacation' is the
                    // low-power/away state. We also never observed 0x1f7=0, so an off
                    // write would be untested. Ideally derive this list from a caps tag
                    // (the cloud's job_modes equivalent) instead of hardcoding.
                    modes: [...Object.values(MODE_R2H)],
                },
            },
        })

        // Measured tank temperature (read-only).
        // state_topic 'topic' makes addField emit the HA key `current_temperature_topic`.
        this.addField(config, {
            id: 0x255,
            name: 'current_temperature',
            comp: 'water_heater',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        // Target temperature setpoint -> `temperature_state_topic` / `temperature_command_topic`
        this.addField(config, {
            id: 0x256,
            name: 'temperature',
            comp: 'water_heater',
            read_xform: (raw) => raw / 2,
            write_xform: (valStr) => {
                const c = Number(valStr)
                const clamped = Math.min(70, Math.max(30, c))
                return Math.round(clamped * 2)
            },
            // the app wrote setpoint and mode together
            write_attach: [0x1f9],
        })

        // Operation mode. The app's SET wrote {0x1f9, 0x256} together, so a mode
        // change attaches the current setpoint (and a setpoint change attaches the
        // mode, above). 0x1f7 (power) is left untouched — the app didn't write it.
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'water_heater',
            read_xform: (raw) => MODE_R2H[raw],
            write_xform: (val) => MODE_H2R[val],
            write_attach: [0x256],
        })

        // --- Diagnostics (hypotheses) -------------------------------------------
        this.addSensor(
            config,
            0x229,
            'temp2',
            'Secondary temperature',
            'mdi:thermometer',
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 1,
            },
            (raw) => raw / 2,
        )

        this.addSensor(config, 0x221, 'error', 'Error code', 'mdi:alert')

        // Hot-water available (0x1ee): ~100 when full/idle, drops while reheating,
        // 0 when depleted. Matches the LG app's tank gauge (e.g. "2/3"). HYPOTHESIS —
        // verify the % against the app's level indicator.
        this.addSensor(config, 0x1ee, 'hot_water', 'Hot water', 'mdi:water-percent', {
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        // Compressor power draw — confirmed at ~1978 W during a heating cycle, 0 idle.
        // read_callback recomputes the Heating sensor whenever power changes.
        const powerComp = {
            platform: 'sensor',
            unique_id: '$deviceid-power_w',
            name: 'Power',
            entity_category: 'diagnostic',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        config['components']['power_w'] = powerComp
        this.addField(config, {
            id: 0x2b3,
            name: '',
            comp: 'power_w',
            writable: false,
            read_callback: () => {
                this.updateHeating()
                return true // also publish the W value normally
            },
        })

        // Heating / compressor-running binary_sensor, derived purely from power draw
        // (recomputed by the 0x2b3 read_callback above). The run-state tag 0x188 is an
        // opaque enum — observed 1 (idle), 3 and 5 (both running, at ~1978 W and
        // ~312 W) — so it can't distinguish running from idle reliably; a nonzero
        // 0x2b3 can. The LG cloud integration can't report this at all (HA #160012).
        const heatingComp = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-heating',
            name: 'Heating',
            device_class: 'running',
            entity_category: 'diagnostic',
            state_topic: '$this/heating-',
        }
        config['components']['heating'] = heatingComp

        this.setConfig(config)
    }

    // Publish the Heating sensor from the latest power draw.
    updateHeating() {
        const on = (this.raw_clip_state[0x2b3] ?? 0) > 0
        this.HA.publishProperty(this.id, 'heating-', on ? 'ON' : 'OFF')
    }

    addSensor(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: (raw: number) => number | string | undefined,
    ) {
        const comp = {
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon ?? undefined,
            entity_category: 'diagnostic',
            ...extra,
        }
        config['components'][name] = comp
        this.addField(config, { id, name: '', comp: name, writable: false, read_xform })
    }

    // Device-to-cloud packets use the 0xA7 TLV marker (byte 6), like the portable
    // AC, not the 0x87 the base class expects. Accept it before delegating.
    processData(buf: Buffer) {
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            buf[10] === buf.length - 13
        ) {
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
            return
        }
        super.processData(buf)
    }

    // Capabilities response carries 0x2da (an eeprom checksum, the same tag the AC
    // uses) and enumerates the supported modes as 0x2d7/0x2d8 pairs. Confirmed from
    // a device-reconnect capture.
    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }
}
