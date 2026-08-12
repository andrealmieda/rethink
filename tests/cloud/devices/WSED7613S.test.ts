import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WSED7613S'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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
        assert.equal(comps.remaining?.unit_of_measurement, 's')

        assert.equal(comps.set_timer?.device_class, 'duration')
        assert.equal(comps.set_timer?.unit_of_measurement, 'min')

        assert.equal(comps.set_temperature?.device_class, 'temperature')
        assert.equal(comps.temperature?.entity_category, 'diagnostic')

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

    test('cooking start: status=on, remaining=900s (15m), setMin=15, setTemp=30, curTemp=25', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX))

        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p['status-'], 'on')
        assert.equal(p['remaining-'], 900) // 15*60
        assert.equal(p['set_timer-'], 15)
        assert.equal(p['set_temperature-'], 30)
        assert.equal(p['temperature-'], 25)

        dev.drop()
    })

    test('countdown: remaining decrements by one second', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX)) // 15:00 = 900s
        thinq.emit('data', buf(COUNTDOWN_HEX)) // 14:59 = 899s

        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 899)

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

    test('done/cancelled: status=off, remaining=0', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(COOKING_START_HEX))
        thinq.emit('data', buf(DONE_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'off')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

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

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})

        dev.drop()
    })
})
