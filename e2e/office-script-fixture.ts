/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Sent to the composer; the fake provider answers it by calling `run_office_script` with the script below. */
export const officeScriptPrompt = 'Write the e2e report as a Word document.'

export const officeScriptFilename = 'e2e-report.docx'

/** Text the document must contain once it is downloaded and unzipped. */
export const officeScriptMarker = 'Sandbox report OFFICE-7Q2X'

/** What a model would write: build a document with the preloaded `docx` library and save it. */
export const officeScript = `
const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph(${JSON.stringify(officeScriptMarker)})] }] })
saveFile(${JSON.stringify(officeScriptFilename)}, await docx.Packer.toArrayBuffer(doc))
`
