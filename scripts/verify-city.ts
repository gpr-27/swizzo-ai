// Saved addresses → city centre for Dineout / Scenes search (shared/cityCoords).
import assert from 'node:assert/strict';
import { cityPointFor } from '../src/shared/cityCoords';

const cases: [string, string | undefined][] = [
  ['Test User: [flat redacted], West Tambaram, Tambaram, Chennai, Tamil Nadu, India', 'Chennai'],
  ['Test User: Iiit, IIIT Tiruchirappalli, Trichy Madurai Hwy, Tiruchirappalli, Tamil Nadu 620012, India', 'Tiruchirappalli'],
  ['Test User: [flat redacted], HAL 3rd Stage, New Tippasandra, Bengaluru, Karnataka, India', 'Bengaluru'],
  ['Test User: Nagamangalam, Manikandam, Tamil Nadu 620012, India', 'Tiruchirappalli'], // by PIN
  ['Test User: main gate, IIIT Nuzvid Campus, Nuzividu, Andhra Pradesh 521202, India', 'Nuzvid'],
  ['Test User: [flat redacted], Ongole, Andhra Pradesh 523001, India', 'Ongole'],
  ['Test User: IIIT collage FATHIMANAGAR, Sethurapatti, Tamil Nadu, India', undefined], // agent asks
];
for (const [line, want] of cases) assert.equal(cityPointFor(line)?.city, want, line);
console.log(`city coords: ${cases.length} passed`);
