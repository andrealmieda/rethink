import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D0211'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'D0211'
const META: Metadata = { modelId: MODEL_ID, modelName: 'DB365TXS', swVersion: '1' }

// Real packet captures from an LG DB365TXS dishwasher (2026-06-27).
//
// Frame format: AA <totalLen> <cmd1> <cmd2> <data…> <crc8> BB
// State record layout (26 bytes, 0-indexed):
//   [2]=state  [3]=sub  [5..6]=v1(BE,minutes)  [9..10]=remaining(BE,minutes)  [13]=temp(°C)
//
// 32_EC double-record packets carry (previous, current); we consume R2 (data[26..51]).

// Single record, startup: state=1 (standby), v1=v2=821 (sentinel — no program selected).
const STANDBY_HEX =
    'AA2032EB001801000003350500033500001C000202010000000000000000C3BB'

// Double record: R1=state=1,v2=18 → R2=state=2,sub=2,v2=18 (cycle just started, 18 min remaining).
const RUNNING_START_HEX =
    'AA3A32EC001801000000120600001200001C000202010000000000000000001802020000120600001200001C0002020100000000000000009ABB'

// Double record: R1=state=2,sub=2,v2=15 → R2=state=2,sub=2,v2=14 (countdown mid-cycle).
const WASHING_14MIN_HEX =
    'AA3A32EC001802020000120600000F00001C000202010000000000000000001802020000120600000E00001C0002020100000000000000009CBB'

// Double record: R1=state=2,sub=2,v2=11 → R2=state=2,sub=3,v2=11 (phase change: washing→rinsing).
const RINSING_HEX =
    'AA3A32EC001802020000120600000B00001C000202010000000000000000001802030000120600000B00001C00020201000000000000000096BB'

// Double record: R1=state=2,sub=4,v2=1 → R2=state=5,sub=5,v2=1 (cycle finishing).
const FINISHING_HEX =
    'AA3A32EC001802040000120600000100001C000202010000000000000000001805050000120600000100001C000202010000000000000000E3BB'

// Double record: R1=state=5,sub=0,v2=1 → R2=state=0,sub=0,v2=1 (cycle done).
const DONE_HEX =
    'AA3A32EC001805000000120000000100001C000202010000000000000000001800000000120000000100001C000202010000000000000000CABB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config publishes status, remaining, and temperature components', () => {
        const { ha, dev } = makeDevice()

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const comps = device.config!.components as Record<string, Record<string, unknown>>

        assert.equal(comps.status?.platform, 'sensor', 'status component')
        assert.equal(comps.status?.device_class, 'enum')
        assert.ok((comps.status?.options as string[]).includes('washing'), 'options include washing')

        assert.equal(comps.remaining?.platform, 'sensor', 'remaining component')
        assert.equal(comps.remaining?.device_class, 'duration')
        assert.equal(comps.remaining?.unit_of_measurement, 'min')

        assert.equal(comps.temperature?.platform, 'sensor', 'temperature component')
        assert.equal(comps.temperature?.entity_category, 'diagnostic')

        dev.drop()
    })

    test('32_EB standby packet: status=standby, remaining=0 (sentinel v2=821)', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(STANDBY_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'standby')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('32_EC running start: status=washing, remaining=18', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(RUNNING_START_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'washing')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 18)
        assert.equal(ha.devices[DEVICE_ID].properties['temperature-'], 28)

        dev.drop()
    })

    test('32_EC countdown: remaining decrements correctly', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(RUNNING_START_HEX)) // remaining=18
        thinq.emit('data', buf(WASHING_14MIN_HEX)) // remaining=14

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'washing')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 14)

        dev.drop()
    })

    test('32_EC phase change: washing → rinsing', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(RUNNING_START_HEX))
        thinq.emit('data', buf(RINSING_HEX))

        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'rinsing')
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 11)

        dev.drop()
    })

    test('32_EC finishing then done: status transitions correctly', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(RUNNING_START_HEX))
        thinq.emit('data', buf(FINISHING_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'finishing')

        thinq.emit('data', buf(DONE_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'off')
        // state=0 → remaining reported as 0 regardless of v2 field value
        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('sentinel v2 value (821) is reported as 0 remaining', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(STANDBY_HEX)) // v2=821

        assert.equal(ha.devices[DEVICE_ID].properties['remaining-'], 0)

        dev.drop()
    })

    test('duplicate packets do not re-publish unchanged state', () => {
        const { ha, thinq, dev } = makeDevice()

        thinq.emit('data', buf(RUNNING_START_HEX))
        const countAfterFirst = Object.keys(ha.devices[DEVICE_ID].properties).length

        thinq.emit('data', buf(RUNNING_START_HEX)) // same state again

        // Property count must not grow (no spurious re-publishes)
        assert.equal(Object.keys(ha.devices[DEVICE_ID].properties).length, countAfterFirst)

        dev.drop()
    })

    test('malformed frames are ignored', () => {
        const { ha, thinq, dev } = makeDevice()

        // wrong start byte
        thinq.emit('data', buf('BB3A32EC001802020000120600000E00001C000202010000000000000000001802020000120600000D00001C0002020100000000000000009CBB'))
        // wrong length
        thinq.emit('data', buf('AA0032EC001802020000120600000E00001C000202010000000000000000001802020000120600000D00001C0002020100000000000000009CBB'))
        // too short
        thinq.emit('data', buf('AA04AABBBBBB'))

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {}, 'no state properties published for bad frames')

        dev.drop()
    })
})
