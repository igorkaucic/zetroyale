const MathPI = Math.PI;
const lat1 = 45.815 * MathPI / 180;
const lon1 = 15.98 * MathPI / 180;
const lat2 = 45.820 * MathPI / 180;
const lon2 = 15.99 * MathPI / 180;

const dLon = lon2 - lon1;
const y = Math.sin(dLon) * Math.cos(lat2);
const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
const heading = (Math.atan2(y, x) * 180 / MathPI + 360) % 360;

console.log(heading);
