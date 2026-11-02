/* Mic adapters: one per mic model whose settings can be changed over USB HID.
   An adapter is a plain object:
     id, name, tested       identity, and whether it has been run on real hardware
     hid                    { vendorId, productId, usagePage?, numbered? } to find the device; numbered
                            when its reports carry a report ID
     labelMatch             a RegExp for the audio input's name, so the page can offer control for that input
     caps                   what can be changed (see core/advice.js)
     describe(state)        one line for a settings state, e.g. "Manual 36 dB · Comp Medium · HPF"
     parseSettings(args)    ["gain=30", "comp=medium"] -> partial target state, for the CLI
     open(transport, opts)  -> device with read(), apply(target), batch(fn), restore(), close(), state
   A transport is { send(reportId, bytes), onReport(cb(reportId, bytes)), close() }; adapters/webhid.js and
   cli/node-hid.js provide one for Chrome and for Node. */
import mv7 from './shure-mv7.js';
import mv7plus from './shure-mv7plus.js';

const ADAPTERS = [mv7, mv7plus];
const adapterFor = ({ vendorId, productId }) => ADAPTERS.find(a => a.hid.vendorId === vendorId && a.hid.productId === productId) || null;
const adapterById = id => ADAPTERS.find(a => a.id === id) || null;
const hidFilters = () => ADAPTERS.map(({ hid }) => ({ vendorId: hid.vendorId, productId: hid.productId, ...(hid.usagePage ? { usagePage: hid.usagePage } : {}) }));

export { ADAPTERS, adapterFor, adapterById, hidFilters };
