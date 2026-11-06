// Full-window preview of the catalog floor. ?select=<device id> preselects; ?focus=<device id> draws one
// device as a portrait; ?t=<seconds> freezes the camera.
import { mount } from './main.js';

const q = new URLSearchParams(location.search);
Object.assign(document.body.style, { margin: '0', display: 'grid', placeItems: 'center', height: '100vh' });
const box = document.createElement('div');
Object.assign(box.style, { width: 'min(100vw, 100vh)', height: 'min(100vw, 100vh)' });
document.body.appendChild(box);
const t = q.get('t');
window.qpuScene = mount(box, { select: q.get('select'), focus: q.get('focus'), frozenAt: t !== null ? +t : null });
