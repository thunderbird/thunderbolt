/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How to build and edit Excel workbooks with `run_office_script`, loaded on demand as a skill. Every ```js block runs
 * in `office-script-skills.test.ts`, which also checks the 2 MiB figure against `sandboxLimits.maxWorkbookBytes`.
 */
export const officeXlsxSkill = `# Excel workbooks with run_office_script

The \`excelize\` global is excelize-wasm: Go Excelize's method names, called synchronously from JavaScript.
- Options are JavaScript objects with PascalCase keys, never JSON strings.
- Cells are A1 names such as "B2", and columns are letters: never give a cell or column as numbers.
- Every call returns an object, such as \`{ error: null }\`, \`{ style }\`, \`{ cell }\`, \`{ value }\` or \`{ buffer, formulaErrors }\`. Take the field you need.
- A call that fails throws an Error that names the method. Let it throw: the run fails, nothing is saved, and you fix the script.

## Example: a new workbook

Values, formulas, a currency format, column widths, a red highlight and a column chart, saved once.

\`\`\`js
const f = excelize.NewFile()
const sheet = "Sheet1"
f.SetSheetRow(sheet, "A1", ["Month", "Income", "Rent", "Food", "Transport", "Spending"])
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
months.forEach((month, i) => {
  const row = i + 2
  f.SetSheetRow(sheet, "A" + row, [month, 6000, 2200, 1500 + i * 250, 600])
  f.SetCellFormula(sheet, "F" + row, "SUM(C" + row + ":E" + row + ")")
})
f.SetCellValue(sheet, "A14", "Year")
for (const col of ["B", "C", "D", "E", "F"]) {
  f.SetCellFormula(sheet, col + "14", "SUM(" + col + "2:" + col + "13)")
}
const header = f.NewStyle({ Font: { Bold: true }, Fill: { Type: "pattern", Pattern: 1, Color: ["#D9E1F2"] } }).style
const money = f.NewStyle({ CustomNumFmt: '"$" #,##0.00' }).style
f.SetCellStyle(sheet, "A1", "F1", header)
f.SetCellStyle(sheet, "B2", "F14", money)
f.SetColWidth(sheet, "A", "F", 15)
// Rows where spending (F) exceeds income (B) turn red.
const red = f.NewConditionalStyle({ Font: { Color: "#9C0006" }, Fill: { Type: "pattern", Pattern: 1, Color: ["#FFC7CE"] } }).style
f.SetConditionalFormat(sheet, "A2:F13", [{ Type: "formula", Criteria: "$F2>$B2", Format: red }])
f.AddChart(sheet, "H2", {
  Type: excelize.Col,
  Series: [{ Name: "Sheet1!$F$1", Categories: "Sheet1!$A$2:$A$13", Values: "Sheet1!$F$2:$F$13" }],
  Title: { Paragraph: [{ Text: "Monthly spending" }] },
  Legend: { Position: "bottom" },
})
// Check the sample data against the rule before saving, so the reply names only rows that really turn red.
const over = months.filter((_, i) => 2200 + 1500 + i * 250 + 600 > 6000)
if (over.length === 0) throw new Error("No month meets the red rule: change the sample values")
console.log("red months:", over.join(", "))
const { buffer, formulaErrors } = f.WriteToBuffer()
console.log("formula errors:", JSON.stringify(formulaErrors))
saveFile("budget.xlsx", buffer)
\`\`\`

## Calls

- Start: \`excelize.NewFile()\` (one sheet, "Sheet1") or \`excelize.OpenReader(readFile(name))\`.
- Values: \`f.SetCellValue(sheet, "B2", 1200)\`; \`f.SetSheetRow(sheet, "A2", [...])\` fills rightwards from A2, \`f.SetSheetCol(sheet, "A2", [...])\` downwards. Numbers stay numbers. A JS Date is saved as text ("2027-03-03T00:00:00.000Z"): write a date as \`f.SetCellFormula(sheet, "A2", "DATE(2027,3,3)")\` with a style such as \`CustomNumFmt: "dd/mm/yyyy"\`.
- Formulas: \`f.SetCellFormula(sheet, "F2", "SUM(C2:E2)")\`, without a leading "=". SetCellValue refuses a string that starts with "="; \`f.SetCellStr\` writes text that must.
- From numbers to names: \`excelize.CoordinatesToCellName(6, 14).cell\` is "F14" (column, row, from 1); \`excelize.ColumnNumberToName(6).col\` is "F".
- Styles: \`f.NewStyle({ Font: { Bold: true, Size: 12, Color: "#1F3864" }, Fill: { Type: "pattern", Pattern: 1, Color: ["#D9E1F2"] }, Alignment: { Horizontal: "center", WrapText: true }, Border: [{ Type: "bottom", Color: "#000000", Style: 1 }], NumFmt: 9 }).style\`, then \`f.SetCellStyle(sheet, "A1", "F1", id)\`. A cell has one style, and SetCellStyle replaces it, so give one NewStyle everything a cell needs.
- Number formats: \`NumFmt\` 3 is #,##0, 4 is #,##0.00, 9 is 0%, 10 is 0.00%, 14 is a date. For money use \`CustomNumFmt\` with the symbol in quotes, \`'"R$" #,##0.00'\`, or a locale tag, \`'[$€-407] #,##0.00'\`. \`NumFmt\` 5 to 8 are not saved, and an unquoted R$ shows as a plain number.
- Layout: \`f.SetColWidth(sheet, "A", "F", 15)\` (first and last column), \`f.SetRowHeight(sheet, 1, 24)\`, \`f.MergeCell(sheet, "A1", "F1")\`, and a frozen header row with \`f.SetPanes(sheet, { Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft" })\`.
- Sheets: \`f.NewSheet("Summary")\`, \`f.SetSheetName("Sheet1", "Budget")\` (then use the new name everywhere, chart references included), \`f.GetSheetList().list\`.
- Reading: \`f.GetRows(sheet).result\` (rows of formatted strings), \`f.GetCellValue(sheet, "B2").value\`, or with \`{ RawCellValue: true }\` for the unformatted value. A formula set in this run reads as "", even after \`WriteToBuffer\`; \`f.CalcCellValue(sheet, "F2").value\` computes it.
- Conditional formats: \`f.SetConditionalFormat(sheet, range, [rules])\` takes an array of rules. \`Format\` is an id from \`f.NewConditionalStyle(style).style\`, a sequence of its own that starts at 0, which is valid. Rule types:
  - \`{ Type: "formula", Criteria: "$F2>$B2", Format }\`: the formula is written for the range's top-left cell, with $ before what must not shift.
  - \`{ Type: "cell", Criteria: ">", Value: "100", Format }\`, or \`Criteria: "between"\` with \`MinValue\` and \`MaxValue\`; values are strings.
  - \`{ Type: "text", Criteria: "containing", Value: "late", Format }\`.
  - With \`Criteria: "="\`: \`top\` and \`bottom\` (\`Value: "3"\`, \`Format\`), \`duplicate\` and \`unique\` (\`Format\`), \`2_color_scale\` and \`3_color_scale\` (\`MinType: "min"\`, \`MaxType: "max"\`, \`MinColor\`, \`MaxColor\`, plus \`MidType: "percentile"\`, \`MidValue: "50"\`, \`MidColor\`), and \`data_bar\` (\`MinType\`, \`MaxType\`, \`BarColor\`).
- Charts: \`f.AddChart(sheet, "H2", { Type, Series: [{ Name, Categories, Values }], Title: { Paragraph: [{ Text }] }, Legend: { Position: "bottom" }, Dimension: { Width: 480, Height: 290 }, YAxis: { NumFmt: { CustomNumFmt: '"$" #,##0' }, MajorGridLines: true }, XAxis: { Title: { Paragraph: [{ Text }] } } })\`.
  - Types are constants on \`excelize\`: \`Col\` (vertical bars), \`ColStacked\`, \`Bar\` (horizontal bars), \`BarStacked\`, \`Line\`, \`Pie\`, \`Doughnut\`, \`Area\`, \`Scatter\`, \`Radar\`; 3-D types have 3D in the name.
  - \`Name\`, \`Categories\` and \`Values\` are absolute references that name the sheet, never literal text: \`Name: "Sheet1!$F$1"\`, \`Values: "Sheet1!$F$2:$F$13"\`, or "'Monthly budget'!$F$2:$F$13" when the name has a space. \`Name: "Spending"\` or \`Values: "F2:F13"\` saves without an error and points at nothing. Add one Series object per series.
  - Every chart excelize writes holds a view3D element; that does not make it a 3-D chart.
- Finish: \`const { buffer, formulaErrors } = f.WriteToBuffer()\`, then \`saveFile(name, buffer)\` once. Saving computes every formula and stores its result, so the file shows numbers where nothing recalculates. \`formulaErrors\` lists each formula that could not be computed as \`{ sheet, cell, formula, error }\`, and the tool result lists them again; the file is saved anyway, so fix the formula or tell the user.

## Mistakes seen in real runs

| Wrong | Right |
|---|---|
| \`f.SetCellValue(sheet, 14, 1, "Total")\` | \`f.SetCellValue(sheet, "A14", "Total")\` |
| \`f.SetColWidth(sheet, "A", 16)\` | \`f.SetColWidth(sheet, "A", "A", 16)\` |
| \`f.SetCellStyle(sheet, "B2", "F14", f.NewStyle(options))\` | \`f.SetCellStyle(sheet, "B2", "F14", f.NewStyle(options).style)\` |
| \`f.SetCellValue(sheet, excelize.CoordinatesToCellName(1, 2), 5)\` | \`excelize.CoordinatesToCellName(1, 2).cell\` |
| \`f.SetCellValue(sheet, "F2", "=SUM(C2:E2)")\`, which throws | \`f.SetCellFormula(sheet, "F2", "SUM(C2:E2)")\` |
| \`Type: "col"\`, \`Type: excelize.ChartTypeCol\`, or a guessed number: \`Type: 1\` is a stacked area chart | \`Type: excelize.Col\` |
| \`f.AddChart(sheet, "H2", JSON.stringify(chart))\`, \`{ type: "bar", series, title }\` | a JS object with PascalCase keys, as above |
| \`Title: "Totals"\`, \`Title: { Name: "Totals" }\` | \`Title: { Paragraph: [{ Text: "Totals" }] }\` |
| \`Series: ["Sheet1!$F$2:$F$13"]\`, \`Paragraph: ["Totals"]\`: excelize stops without an error, and the next call fails with "Go program has already exited" | \`Series: [{ Name, Categories, Values }]\`, \`Paragraph: [{ Text: "Totals" }]\` |
| \`{ Type: "expression", Formula: "..." }\` | \`{ Type: "formula", Criteria: "$F2>$B2", Format }\` |
| \`Criteria: "=$F2>$B2"\` | \`Criteria: "$F2>$B2"\` |
| one rule object instead of an array, which throws | \`[{ Type: "formula", ... }]\` |
| \`Format: f.NewStyle(...).style\` ("invalid style ID") | \`Format: f.NewConditionalStyle(...).style\` |
| \`if (!red) throw ...\` on the first conditional style | 0 is the first valid id |
| \`Fill: { Type: "pattern", Color: "#FFC7CE" }\` or two colors | \`Fill: { Type: "pattern", Pattern: 1, Color: ["#FFC7CE"] }\` |
| \`Font: { Color: "red" }\` | \`Font: { Color: "#9C0006" }\` |
| try/catch around a call, then saving anyway | let it throw, so a file without its chart or highlight is never saved |
| sample data where no row meets the highlight the user asked for, found after saving and fixed with a second save; or a reply naming highlighted rows from memory | choose values that meet the rule, compute the matching rows from the arrays you wrote, throw before saving when there are none, log them, and name only the logged rows in the reply |
| writing chart, drawing or conditional-format XML with fflate after AddChart or SetConditionalFormat fails | fix the failing call; the rows above cover the usual mistakes |
| \`saveFile("probe.xlsx", ...)\` or \`saveFile("errors.txt", ...)\` to see a result | \`console.log\` it in a run that saves nothing |
| \`console.log(result)\`, which prints [object Object] | \`console.log(JSON.stringify(result))\` |
| \`f.SaveAs(name)\`, \`f.Write()\`, \`f.Close()\` | \`saveFile(name, f.WriteToBuffer().buffer)\`; there is nothing to close |

## Editing an attached workbook

List its exact name in \`inputs\`, open it with \`excelize.OpenReader(readFile(name))\`, change only what the user asked for, and save under the same name. Opening keeps what the script does not change, including styles, charts, images, pivot tables and macros. When you do not know the layout, log \`f.GetSheetList().list\` and \`f.GetRows(sheet).result\` first, in a run that saves nothing or before the change, as here:

\`\`\`js
const name = "sales.xlsx"
const f = excelize.OpenReader(readFile(name))
const sheet = f.GetSheetList().list[0]
const rows = f.GetRows(sheet).result
console.log(JSON.stringify(rows))
f.SetCellValue(sheet, "B4", 90)
const total = rows.length + 1
f.SetCellValue(sheet, "A" + total, "Total")
f.SetCellFormula(sheet, "B" + total, "SUM(B1:B" + rows.length + ")")
const { buffer, formulaErrors } = f.WriteToBuffer()
console.log("formula errors:", JSON.stringify(formulaErrors))
saveFile(name, buffer)
\`\`\`

Never rebuild an attached workbook from its extracted text or from the copy in your workspace: that loses its formulas and formatting. Open it with excelize, or tell the user why you cannot.

## Limits

- excelize opens workbooks of up to 2 MiB. For a larger one, tell the user it is too large to edit here; do not rebuild or unzip it.
- \`excelize.OpenReader(bytes, { Password: "..." })\` opens a password-encrypted workbook, but \`WriteToBuffer\` takes no options and saves an unencrypted copy: tell the user the copy no longer asks for a password. Sheet and workbook protection (\`ProtectSheet\`, \`ProtectWorkbook\`) stay.
- This tool never adds macros, and \`AddVBAProject\` throws. A .xlsm can be saved only from a .xlsm the run read, under its own extension; save every other workbook as .xlsx, including one opened from a .xlsx. The chat cannot attach a .xlsm, so do not ask the user to upload one; a .xlsm this tool saved earlier in the chat, or, if you have a workspace, one there, can still be read and edited.`
