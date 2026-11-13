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

/** Sent with an attached document; the fake provider answers it by calling `run_office_script` to edit that file. */
export const officeEditPrompt = 'Mark the attached brief as final.'

export const officeEditFilename = 'e2e-brief.docx'

/** The attached document holds this placeholder; the edited copy holds {@link officeEditMarker} in its place. */
export const officeEditPlaceholder = '{{status}}'

export const officeEditMarker = 'Final OFFICE-EDIT-3K9P'

/** What a model would write to edit the attachment: read it, patch its placeholder, save it under its own name. */
export const officeEditScript = `
const patched = await docx.patchDocument({
  outputType: 'uint8array',
  data: readFile(${JSON.stringify(officeEditFilename)}),
  patches: { status: { type: docx.PatchType.PARAGRAPH, children: [new docx.TextRun(${JSON.stringify(officeEditMarker)})] } },
})
saveFile(${JSON.stringify(officeEditFilename)}, patched)
`
