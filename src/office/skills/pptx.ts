/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How to build and edit PowerPoint decks with `run_office_script`, loaded on demand as a skill. Every ```js block runs
 * in `office-script-skills.test.ts`.
 */
export const officePptxSkill = `# PowerPoint presentations with run_office_script

The \`PptxGenJS\` global is PptxGenJS 4. Create \`new PptxGenJS()\`, set \`pres.layout = "LAYOUT_WIDE"\` before adding slides for a 13.33 × 7.5 inch canvas, add slides and objects, then get the bytes with \`await pres.write({ outputType: "uint8array" })\`; \`pres.writeFile\` does not work here. \`animatePptx(bytes, plan)\` returns those bytes with animations and slide transitions added. Save the final bytes once.

## Example: a new deck with animations

\`\`\`js
const pres = new PptxGenJS()
pres.layout = "LAYOUT_WIDE"

const cover = pres.addSlide()
cover.background = { color: "1F3864" }
cover.addText("Quarterly review", { objectName: "title", x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 44, bold: true, color: "FFFFFF" })
cover.addText("Q3 results", { objectName: "subtitle", x: 0.8, y: 3.9, w: 11.7, h: 0.8, fontSize: 24, color: "D9E1F2" })
cover.addShape(pres.ShapeType.ellipse, { objectName: "badge", x: 11.2, y: 0.5, w: 1.4, h: 1.4, fill: { color: "FFC000" } })

const results = pres.addSlide()
results.addText("Results", { objectName: "heading", x: 0.6, y: 0.4, w: 12, h: 0.8, fontSize: 32, bold: true })
results.addText(
  [
    { text: "Revenue up 12%", options: { bullet: true, breakLine: true } },
    { text: "Two new stores", options: { bullet: true, breakLine: true } },
    { text: "Online sales doubled", options: { bullet: true } },
  ],
  { objectName: "points", x: 0.6, y: 1.4, w: 5.6, h: 2.4, fontSize: 20 },
)
results.addTable(
  [
    [{ text: "Region", options: { bold: true, fill: { color: "D9E1F2" } } }, { text: "Revenue", options: { bold: true, fill: { color: "D9E1F2" } } }],
    ["North", "$120,000"],
    ["South", "$95,000"],
  ],
  { objectName: "regions", x: 0.6, y: 4.2, w: 5.6, colW: [2.8, 2.8], fontSize: 16, border: { type: "solid", pt: 1, color: "BFBFBF" } },
)
results.addChart(
  pres.ChartType.bar,
  [{ name: "Revenue", labels: ["Q1", "Q2", "Q3"], values: [180, 195, 215] }],
  { x: 6.8, y: 1.4, w: 6, h: 4.6, barDir: "col", showTitle: true, title: "Revenue by quarter" },
)
results.addNotes("Mention the store openings.")

const bytes = await pres.write({ outputType: "uint8array" })
const animated = animatePptx(bytes, {
  effects: [
    { slide: 1, shape: "title", effect: "fadeIn", start: "withPrevious" },
    { slide: 1, shape: "subtitle", effect: "flyIn", direction: "bottom", start: "afterPrevious" },
    { slide: 1, shape: "badge", effect: "pulse", start: "afterPrevious", repeat: "indefinite" },
    { slide: 2, shape: "points", effect: "wipeIn", direction: "left" },
    { slide: 2, shape: "regions", effect: "fadeIn", start: "afterPrevious", delayMs: 300 },
  ],
  transitions: [
    { slide: 1, effect: "fade" },
    { slide: 2, effect: "push", direction: "right", speed: "medium" },
  ],
})
saveFile("review.pptx", animated)
\`\`\`

## Building blocks

- Positions and sizes are inches (\`x\`, \`y\`, \`w\`, \`h\`). LAYOUT_WIDE is 13.33 × 7.5; the default, LAYOUT_16x9, is 10 × 5.625. Keep every object on the slide.
- Colors are hex without "#", such as "1F3864".
- Text: \`slide.addText(text, { x, y, w, h, fontSize, bold, color, align: "center", valign: "middle", fontFace })\`. For bullets pass runs, as above; \`bullet: { type: "number" }\` numbers them.
- Shapes: \`slide.addShape(pres.ShapeType.rect, { x, y, w, h, fill: { color }, line: { color, width } })\`, also \`ellipse\`, \`roundRect\` and \`line\`.
- Tables: \`slide.addTable(rows, { x, y, w, colW, fontSize, border })\`; a cell is a string or \`{ text, options: { bold, color, fill: { color } } }\`.
- Charts: \`slide.addChart(pres.ChartType.bar, [{ name, labels, values }], { x, y, w, h, barDir: "col" })\`, one object per series. \`barDir: "col"\` draws vertical bars and \`"bar"\` horizontal ones; other types are \`line\`, \`pie\`, \`doughnut\`, \`area\` and \`radar\`. For \`scatter\` the first object holds the X values, \`{ name: "X", values }\`, and each later object one series of Y values. \`showTitle\`, \`title\`, \`showLegend\` and \`legendPos: "b"\` label it.
- Pictures: \`slide.addImage({ data: "image/png;base64,...", x, y, w, h })\`. There is no network, so a \`path\` or URL never loads: read an attached picture with \`readFile\` and turn its bytes into base64, as below, which applies only when the user attached logo.png, listed in \`inputs\`. A GIF keeps its animation.
- Notes: \`slide.addNotes(text)\`. Background: \`slide.background = { color }\`.

\`\`\`js
const bytes = readFile("logo.png")
let binary = ""
for (const byte of bytes) binary += String.fromCharCode(byte)
const pres = new PptxGenJS()
pres.layout = "LAYOUT_WIDE"
pres.addSlide().addImage({ data: "image/png;base64," + btoa(binary), x: 5.4, y: 2.5, w: 2.5, h: 2.5 })
saveFile("logo.pptx", await pres.write({ outputType: "uint8array" }))
\`\`\`

## animatePptx

\`animatePptx(bytes, { effects, transitions })\` takes both lists in one call: a second call that animates a slide again is refused.
- An effect is \`{ slide, shape, effect, start, delayMs, durationMs, repeat, direction }\`. \`durationMs\` and \`repeat\` do not apply to \`appear\` and \`disappear\`. \`slide\` counts from 1 in presentation order. \`shape\` is the object's name: the \`objectName\` you gave it, unique on its slide, or the name an existing deck gives it.
- Effects: entrance \`appear\`, \`fadeIn\`, \`flyIn\`, \`wipeIn\`; emphasis \`blink\`, \`pulse\`, \`growShrink\`, \`spin\`; exit \`disappear\`, \`fadeOut\`.
- Effects play in the order of the list. \`start\` is "onClick" by default; "withPrevious" plays with the effect before it, or on slide entry for the first; "afterPrevious" waits for the effect before it and the ones playing with that effect: it plays when the last finite one ends, delays included, or once each has played one cycle when all of them repeat indefinitely, and on slide entry when it is the first. Only "onClick" waits for a click, so tell the user an effect waits for one only when it does. \`delayMs\` waits before starting, \`durationMs\` sets one cycle, and \`repeat\` is the total number of plays or "indefinite".
- \`direction\` is the edge an effect comes from, "top", "right", "bottom" or "left", for \`flyIn\` and \`wipeIn\`.
- A transition is \`{ slide, effect, direction, speed }\`: \`fade\`, \`wipe\`, \`push\`, \`zoom\`, \`cover\` or \`dissolve\`; \`speed\` is "fast", "medium" or "slow"; \`direction\` is an edge for \`wipe\`, \`push\` and \`cover\`, or "in" or "out" for \`zoom\`.
- Targets are top-level shapes, text boxes, pictures, whole groups and tables on the slide canvas; a chart cannot be animated.
- A slide that already has animations or a transition is refused for that kind. For those, for other effects and for motion paths, edit the slide's \`p:timing\` and \`p:transition\` XML with fflate and xmldom.
- An error names each failing entry, such as \`effects[2]\`, and for a missing name lists the names on that slide.

## Editing an attached deck

PptxGenJS cannot open a file. List the deck's exact name in \`inputs\`, unzip it with \`fflate.unzipSync(readFile(name))\`, change the slide XML with \`xmldom\`, zip it with \`fflate.zipSync(parts)\`, optionally run animatePptx, and save under the same name. Write back only the parts you changed, and leave the others as they are, even when their XML declares an encoding such as windows-1252. Slides are \`ppt/slides/slideN.xml\`, but their order comes from \`p:sldIdLst\` in \`ppt/presentation.xml\`, so N need not be the position. First find the shapes' names and text in a run that saves nothing:

\`\`\`js
const parts = fflate.unzipSync(readFile("deck.pptx"))
console.log(fflate.strFromU8(parts["ppt/presentation.xml"]).match(/<p:sldSz[^>]*>/)[0])
for (const path of Object.keys(parts).filter((path) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(path))) {
  const slide = new xmldom.DOMParser().parseFromString(fflate.strFromU8(parts[path]), "application/xml")
  const shapes = Array.from(slide.getElementsByTagName("p:sp")).map((shape) => ({
    name: shape.getElementsByTagName("p:cNvPr")[0].getAttribute("name"),
    text: Array.from(shape.getElementsByTagName("a:t")).map((t) => t.textContent).join(" "),
  }))
  console.log(path, JSON.stringify(shapes), slide.getElementsByTagName("p:timing").length ? "has animations" : "")
}
\`\`\`

Then change the text and animate the shape by its name:

\`\`\`js
const name = "deck.pptx"
const parts = fflate.unzipSync(readFile(name))
const path = "ppt/slides/slide1.xml"
const slide = new xmldom.DOMParser().parseFromString(fflate.strFromU8(parts[path]), "application/xml")
const title = Array.from(slide.getElementsByTagName("p:sp")).find(
  (shape) => shape.getElementsByTagName("p:cNvPr")[0].getAttribute("name") === "The Title",
)
title.getElementsByTagName("a:t")[0].textContent = "Results for 2027"
parts[path] = fflate.strToU8(new xmldom.XMLSerializer().serializeToString(slide))
const out = animatePptx(fflate.zipSync(parts), {
  effects: [{ slide: 1, shape: "The Title", effect: "fadeIn", start: "withPrevious" }],
  transitions: [{ slide: 2, effect: "fade" }],
})
saveFile(name, out)
\`\`\`

Adding or copying a slide by hand means adding the slide part and its \`_rels\` file, an override in \`[Content_Types].xml\`, a relationship in \`ppt/_rels/presentation.xml.rels\` and a \`p:sldId\` in \`ppt/presentation.xml\`.

## Mistakes to avoid

- \`pres.writeFile(...)\`: use \`await pres.write({ outputType: "uint8array" })\`.
- Setting \`pres.layout\` after \`addSlide\`: set it first.
- \`color: "#FF0000"\`: write "FF0000".
- \`pres.ChartType.column\`: there is none; use \`pres.ChartType.bar\` with \`barDir: "col"\`.
- Saving the deck and then an animated copy: run animatePptx on the bytes and save once.
- Two objects with the same \`objectName\` on a slide: animatePptx cannot tell them apart.
- \`console.log(value)\` prints [object Object]: log \`JSON.stringify(value)\`.`
