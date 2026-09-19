import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile("desktop/assets/icon.svg", "utf8");
const png = new Resvg(svg).render().asPng();
await writeFile("desktop/assets/icon.png", png);
const small = new Resvg(svg, { fitTo: { mode: "width", value: 256 } }).render().asPng();
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(small.length, 14);
icoHeader.writeUInt32LE(22, 18);
await writeFile("desktop/assets/icon.ico", Buffer.concat([icoHeader, small]));
console.log("Product icons built from the checked-in SVG.");
