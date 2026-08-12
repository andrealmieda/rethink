import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WSED7613S'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-oven-id'
const MODEL_ID = 'WSED7613S'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WS7D7631WB', swVersion: '1' }

// Real packet captures from an LG WS7D7631WB steam oven (2026-07-07).
//
// Frame format: AA <totalLen> <cmd1> <cmd2> <data…> <crc8> BB
// Record layout (115 bytes, 0-indexed):
//   [14]=state  [16]=seconds  [17]=minutes  [19]=set_min  [22]=set_temp  [24]=cur_temp
//
// 40_EC double-record packets carry (previous, current); we consume R2 (data[115..229]).

// Single record, startup: state=0 (off), all fields zero.
const STARTUP_HEX =
    'AA7940EB0000010000010200FF030002000000000000000000000000000000000000001E000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000021BB'

// Double record: R2=state=0 (fully idle, all zeros after a completed stop).
const IDLE_HEX =
    'AAEC40EC0000010000010200FF030002000000000000000000000000000000000000001E00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF0300020000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000054BB'

// Double record: R2=state=1, 15m00s remaining, set=15min, setTemp=30°C, curTemp=25°C.
const COOKING_START_HEX =
    'AAEC40EC0000010000010200FF030002000000000000000000000000000000000000001100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF03000200000181000F000F00801E001900002000000013000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038BB'

// Double record: R2=state=1, 14m59s remaining.
const COUNTDOWN_HEX =
    'AAEC40EC0000010000010200FF03000200000181000F000F00801E00190000200000001300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF030002000001813B0E000F00801E001900002000000013000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000075BB'

// Double record: R2=state=1, 14m39s, curTemp risen to 30°C (reached setpoint).
const TEMP_REACHED_HEX =
    'AAEC40EC0000010000010200FF03000200000181280E000F00801E00190000200000001300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF03000200000181270E000F00801E001E0000200000001300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006DBB'

// Double record: R1=state=2 (stopping), R2=state=0 (done/off after cancel).
const DONE_HEX =
    'AAEC40EC0000010000010200FF03000200000281030E000F00801E001E0000200000001300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF030002000000000000000000000000000000000000001E0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000D7BB'

// Real capture (2026-08-12), oven idle after a cook: R2 has byte[27]=0x04 for the
// few seconds the door was physically open.
const DOOR_OPEN_IDLE_HEX =
    'AAEC40EC0000010000010200FF030002000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF0300020000000000000000000000000000000400000016000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000057BB'

// Real capture (2026-08-12), same idle session ~3s later: door closed again, byte[27] back to 0x00.
const DOOR_CLOSED_IDLE_HEX =
    'AAEC40EC0000010000010200FF030002000000000000000000000000000000040000001600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000010200FF0300020000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000057BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config publishes all expected components', () => {
        const { ha, dev } = makeDevice()

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA config published')
        const comps = device.config!.components as Record<string, Record<string, unknown>>

        assert.equal(comps.status?.platform, 'sensor')
        assert.equal(comps.status?.device_class, 'enum')
        assert.ok((comps.status?.options as string[]).includes('on'))

        assert.equal(comps.remaining?.device_class, 'duration')
        assert.equal(comps.remaining?.unit_of_measurement, 'min')

        assert.equal(comps.set_timer?.device_class, 'duration')
        assert.equal(comps.set_timer?.unit_of_measurement, 'min')

        assert.equal(comps.set_temperature?.device_class, 'temperature')
        assert.equal(comps.temperature?.entity_category, 'diagnostic')

        assert.equal(comps.start_function?.platform, 'select')
        assert.deepEqual(comps.start_function?.options, ['air_fry', 'top_bottom_heat'])
        assert.equal(comps.start_temperature?.platform, 'number')
        assert.equal(comps.start_duration?.platform, 'number')
        assert.equal(comps.start?.platform, 'button')
        assert.equal(comps.stop?.platform, 'button')
        assert.equal(comps.refresh, undefined, 'refresh is automatic, not a button')

        assert.equal(comps.door?.platform, 'binary_sensor')
        assert.equal(comps.door?.device_class, 'door')

        dev.drop()
    })

    test('40_EB startup packet: status=off, remaining=0', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(STARTUP_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'off')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('40_EC idle packet: status=off, remaining=0', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(IDLE_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'off')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('cooking start: status=on, remaining=15min, setMin=15, setTemp=30, curTemp=25', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX))

        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p['status-'], 'on')
        assert.equal(p['remaining-'], 15) // 15m00s
        assert.equal(p['set_timer-'], 15)
        assert.equal(p['set_temperature-'], 30)
        assert.equal(p['temperature-'], 25)

        dev.drop()
    })

    test('countdown: remaining decrements by one second, reported in minutes', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX)) // 15m00s = 15 min
        thinq.emit('data', buf(COUNTDOWN_HEX)) // 14m59s = 14.98 min

        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 14.98)

        dev.drop()
    })

    test('ambient temperature is published and decays after a cook', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX)) // ambTemp=19 (pre-cook)
        assert.equal(ha.devices[DEVICE_ID].properties['ambient_temperature-'], 19)

        thinq.emit('data', buf(DONE_HEX)) // ambTemp=30 (residual heat right after a 30°C cook)
        assert.equal(ha.devices[DEVICE_ID].properties['ambient_temperature-'], 30)

        thinq.emit('data', buf(IDLE_HEX)) // ambTemp=17 (cooled down during a longer idle)
        assert.equal(ha.devices[DEVICE_ID].properties['ambient_temperature-'], 17)

        dev.drop()
    })

    test('temperature rises to setpoint', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX)) // curTemp=25
        thinq.emit('data', buf(TEMP_REACHED_HEX)) // curTemp=30

        assert.equal(ha.devices[DEVICE_ID].properties['temperature-'], 30)

        dev.drop()
    })

    test('start button defaults to the confirmed 200C/15min air-fry command', () => {
        const { ha, thinq, dev } = makeDevice()

        ha.setProperty(DEVICE_ID, 'start', 'command', '')

        assert.equal(thinq.outbox.length, 1)
        // Real capture (2026-08-12): AA 17 F0 43 20 0B 18 00 00 00 01 00 C8 00 0F 00
        // 00 00 00 00 5A BB - 0xC8=200C, 0x0F=15min at their captured offsets.
        assert.equal(thinq.outbox[0].toString('hex'), 'aa17f043200b180000000100c8000f0000000000005abb')

        dev.drop()
    })

    test('setting start_temperature/start_duration changes what start sends', () => {
        const { ha, thinq, dev } = makeDevice()

        ha.setProperty(DEVICE_ID, 'start_temperature', 'command', '170')
        ha.setProperty(DEVICE_ID, 'start_duration', 'command', '20')
        assert.equal(ha.devices[DEVICE_ID].properties['start_temperature-'], 170)
        assert.equal(ha.devices[DEVICE_ID].properties['start_duration-'], 20)

        ha.setProperty(DEVICE_ID, 'start', 'command', '')

        assert.equal(thinq.outbox.length, 1)
        // Real capture (2026-08-12): AA 17 F0 43 20 0B 18 00 00 00 01 00 AA 00 14 00
        // 00 00 00 00 A3 BB - 0xAA=170C, 0x14=20min, otherwise byte-identical to the
        // 200C/15min sample - confirming these are the only two variable bytes.
        assert.equal(thinq.outbox[0].toString('hex'), 'aa17f043200b180000000100aa0014000000000000a3bb')

        dev.drop()
    })

    test('setting start_function to top_bottom_heat changes the <func> byte', () => {
        const { ha, thinq, dev } = makeDevice()

        ha.setProperty(DEVICE_ID, 'start_function', 'command', 'top_bottom_heat')
        ha.setProperty(DEVICE_ID, 'start_temperature', 'command', '170')
        ha.setProperty(DEVICE_ID, 'start_duration', 'command', '15')
        assert.equal(ha.devices[DEVICE_ID].properties['start_function-'], 'top_bottom_heat')

        ha.setProperty(DEVICE_ID, 'start', 'command', '')

        assert.equal(thinq.outbox.length, 1)
        // Real capture (2026-08-12): AA 17 F0 43 20 0B 03 00 00 00 01 00 AA 00 0F 00
        // 00 00 00 00 89 BB - <func>=0x03 instead of air fry's 0x18, otherwise the
        // same template.
        assert.equal(thinq.outbox[0].toString('hex'), 'aa17f043200b030000000100aa000f00000000000089bb')

        dev.drop()
    })

    test('adjusting temp/duration mid-run sends the same command as starting', () => {
        const { ha, thinq, dev } = makeDevice()

        ha.setProperty(DEVICE_ID, 'start_function', 'command', 'top_bottom_heat')
        ha.setProperty(DEVICE_ID, 'start_temperature', 'command', '190')
        ha.setProperty(DEVICE_ID, 'start_duration', 'command', '20')
        ha.setProperty(DEVICE_ID, 'start', 'command', '')

        assert.equal(thinq.outbox.length, 1)
        // Real capture (2026-08-12): the app adjusted a running 170C/15min
        // top/bottom-heat cook to 190C/20min with this exact command - no separate
        // "update" command exists, it's the same 0xF043.
        assert.equal(thinq.outbox[0].toString('hex'), 'aa17f043200b030000000100be0014000000000000a0bb')

        dev.drop()
    })

    test('stop button sends the confirmed stop command', () => {
        const { ha, thinq, dev } = makeDevice()

        ha.setProperty(DEVICE_ID, 'stop', 'command', '')

        assert.equal(thinq.outbox.length, 1)
        // Real capture (2026-08-12): AA 07 F0 44 00 B0 BB
        assert.equal(thinq.outbox[0].toString('hex'), 'aa07f04400b0bb')

        dev.drop()
    })

    test('keepalive pings periodically, backs off after an unanswered ping, resumes on reply', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        tickMockTimers(t, 2 * 60 * 1000)
        assert.equal(thinq.outbox.length, 1, 'first keepalive ping sent after 2 minutes')
        // Real capture (2026-08-12): the confirmed 0xF0ED query payload.
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa28f0ed114101000000181a1017181c272e2f33505356595c00000000000000000000000000a1bb',
        )

        // No reply within the 10s window -> marked asleep, no further spam
        tickMockTimers(t, 10 * 1000)
        tickMockTimers(t, 2 * 60 * 1000)
        assert.equal(thinq.outbox.length, 1, 'no further ping sent once one goes unanswered')

        // Device shows a real sign of life on its own (e.g. woken by the door)
        thinq.emit('data', buf(IDLE_HEX))

        tickMockTimers(t, 2 * 60 * 1000)
        assert.equal(thinq.outbox.length, 2, 'pinging resumes after the device replies on its own')

        dev.drop()
    })

    test('done/cancelled: status=off, remaining=0', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX))
        thinq.emit('data', buf(DONE_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'off')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('door opens and closes while idle (byte[27] bit 0x04)', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(IDLE_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['door-'], 'OFF')

        thinq.emit('data', buf(DOOR_OPEN_IDLE_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['door-'], 'ON')

        thinq.emit('data', buf(DOOR_CLOSED_IDLE_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['door-'], 'OFF')

        dev.drop()
    })

    test('duplicate packets do not re-publish', () => {
        const { ha, thinq, dev } = makeDevice()

        let publishCount = 0
        const orig = ha.publishProperty.bind(ha)
        ha.publishProperty = (id: string, prop: string, value: string | number) => {
            if (prop !== 'availability') publishCount++
            orig(id, prop, value)
        }

        thinq.emit('data', buf(COOKING_START_HEX))
        const countAfterFirst = publishCount

        thinq.emit('data', buf(COOKING_START_HEX))
        assert.equal(publishCount, countAfterFirst, 'no re-publish for identical packet')

        dev.drop()
    })

    test('malformed frames are ignored', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf('BB0440EC1234BB')) // wrong start byte
        thinq.emit('data', buf('AA0040EC1234BB')) // wrong length
        thinq.emit('data', buf('AA04AABBBBBB')) // too short

        // Only the staged start defaults (published at construction) should be
        // present - no device-state properties from any of the malformed frames.
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            'start_function-': 'air_fry',
            'start_temperature-': 200,
            'start_duration-': 15,
        })

        dev.drop()
    })
})
