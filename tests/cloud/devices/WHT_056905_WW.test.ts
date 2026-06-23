import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WHT_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WHT_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WH20STR2.FA', swVersion: '115100' }

// Real packet capture from an LG WH20STR2.FA heat-pump water heater (wh27s, 2026-06-21).
// Full state dump (device->cloud, 0xA7 marker). Decodes to 19 tags including:
//   0x1f7=1   power ON
//   0x1f9=26  mode (== "auto" under the assumed ordering)
//   0x255=118 measured temp -> 59 °C
//   0x256=104 setpoint      -> 52 °C
//   0x188=1   run state (idle)
const FULL_DUMP_HEX =
    '000004000000A7020492327E501A7DC1955076959068A2407F0088408A008A50' +
    '2F8A808CA014408CD046ACC0D5600D27D5A010E0C90062017B906457403A88'

// Real capabilities response (reply to 0x1f5=1, frame marker buf[8]=0x01). Carries
// 0x2da plus the 0x2d7/0x2d8 mode pairs. Captured from a device reconnect.
const CAPS_HEX =
    '000004000000A702010949B01012B4901EB0C1B103B4F0020000B543B69044B6F076' +
    '7601BC30808100BD3001FD00B701BC41BD600203D3C07948FA01B5D019B61046B5D0' +
    '1AB61046B5D01BB61046B5D01CB610460B13'

// Decode the TLV payload out of a framed packet (same offsets for rx and tx).
function frameTLV(b: Buffer) {
    return TLV.parse(b.subarray(11, b.length - 2))
}
function tagValue(b: Buffer, tag: number) {
    return frameTLV(b).find((e) => e.t === tag)?.v
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet; discard it.
    thinq.resetRecorder()

    // Real caps response (carries 0x2da) satisfies isCapsResponse and triggers values query.
    thinq.emit('data', buf(CAPS_HEX))
    assert.equal(thinq.outbox.length, 1, 'caps response triggers a values query')
    assert.equal(tagValue(thinq.outbox[0], 0x1f5), 2, 'values query is 0x1f5=2')

    thinq.emit('data', buf(FULL_DUMP_HEX))
    tickMockTimers(t, 1000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes a water_heater component with the LG modes', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const components = device.config!.components as Record<string, Record<string, unknown>>

        assert.ok(components.water_heater, 'water_heater component')
        assert.equal(components.water_heater.platform, 'water_heater')
        assert.deepEqual(components.water_heater.modes, ['heat_pump', 'eco', 'performance', 'vacation'])
        assert.equal(components.water_heater.temperature_unit, 'C')

        dev.drop()
    })

    test('full dump publishes temperature and mode', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(FULL_DUMP_HEX))
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'current_temperature'), 59) // 0x255=118 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'temperature_state'), 52) // 0x256=104 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'mode_state'), 'eco') // 0x1f9=26 = LG Auto
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'idle') // 0x2b3=0
        assert.equal(ha.getProperty(DEVICE_ID, 'run_state', 'state'), 1) // 0x188 raw
        assert.equal(ha.getProperty(DEVICE_ID, 'dbg_355', 'state'), 3367) // raw debug tag

        dev.drop()
    })

    test('heating-cycle dump reports power and Status=heating', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Real dump captured mid-heating: 0x2b3=1978 W, 0x188=3.
        const HEATING_HEX =
            '000004000000A702040B317E501C7DC195506B95906AA2407F0088408A008A50' +
            '2F8A808C838CD02AACE007BAD5600D0BD5A010E0C90062037B805740ABBA'
        thinq.emit('data', buf(HEATING_HEX))
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'power_w', 'state'), 1978) // 0x2b3
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'heating')

        dev.drop()
    })

    test('Status: power draw drives idle -> standby -> heating', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'idle') // baseline 0 W

        // Real single-tag notification: 0x2b3 = 65 W (compressor running) -> heating.
        thinq.emit('data', buf('000004000000A70204FF03ACD0416E2B'))
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'power_w', 'state'), 65)
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'heating') // 65 W >= 40

        // Real vacation/standby dump: 0x2b3 = 17 W -> standby, not heating.
        thinq.emit(
            'data',
            buf(
                '000004000000A70204D1337E501C7DC195506B95906CA2407F0088408A008A502F8A808CA0023D8CD018ACD011D5600CF2D5A010E0C90062017B906457403AA3',
            ),
        )
        tickMockTimers(t, 1000)
        assert.equal(ha.getProperty(DEVICE_ID, 'power_w', 'state'), 17)
        assert.equal(ha.devices[DEVICE_ID].properties['status-'], 'standby') // 0 < 17 < 40

        dev.drop()
    })

    test('setting temperature writes 0x256 (2 x °C)', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'water_heater', 'temperature_command', '53')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(tagValue(thinq.outbox[0], 0x256), 106, '53 °C -> raw 106')

        dev.drop()
    })

    test('setting mode=vacation writes 0x1f9=28 bundled with the setpoint', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'water_heater', 'mode_command', 'vacation')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(tagValue(thinq.outbox[0], 0x1f9), 28, 'vacation -> mode 28')
        // mode write attaches the current setpoint, mirroring the app's SET packet
        assert.equal(tagValue(thinq.outbox[0], 0x256), 104, 'setpoint attached (0x256)')
        // the app did not touch the power tag on a mode change
        assert.equal(tagValue(thinq.outbox[0], 0x1f7), undefined, 'power tag not written')

        dev.drop()
    })
})
