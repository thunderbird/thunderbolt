/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { webToolCaps } from '../web-tool-budget'
import { evalModels } from './scenarios'
import type { EvalCriteria, EvalExpectation, EvalScenario, NecessityCategory } from './types'

type NecessityPrompt = Pick<
  EvalScenario,
  | 'id'
  | 'prompt'
  | 'followUps'
  | 'criteria'
  | 'expectation'
  | 'promptCriteria'
  | 'promptExpectation'
  | 'isNegativeControl'
> & { category: NecessityCategory }

const reviewBy = '2026-11-04'

const noSearchCorrect: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
  expectResearchSkill: false,
  expectCorrectAnswer: true,
}

const weatherWidget: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
  expectResearchSkill: false,
  mustUseWidget: 'weather-forecast',
}

const answerThenOffer: EvalCriteria = { ...noSearchCorrect, expectSearchOffer: true }

const searchOnce: EvalCriteria = {
  mustProduceOutput: true,
  minToolCalls: 1,
  maxToolCalls: webToolCaps.auto,
  noDuplicateToolCalls: true,
  expectResearchSkill: false,
}

const evidenceLookup: EvalCriteria = { ...searchOnce, expectEvidenceCoverage: true }

const researchSearch: EvalCriteria = {
  mustProduceOutput: true,
  minToolCalls: 1,
  noDuplicateToolCalls: true,
  expectResearchSkill: true,
  expectEvidenceCoverage: true,
}

const deepResearchSearch: EvalCriteria = { ...researchSearch, minToolCalls: 2 }

const reusePriorResult: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: 0,
  expectResearchSkill: false,
  expectReuseFidelity: true,
}

const reuseExpectation: EvalExpectation = {
  expectReuseFidelity:
    'Faithfully repeat the requested earlier value, applying only the transformation asked for in the follow-up. Do not require restating a time, channel or other qualifier the follow-up did not ask for. Do not substitute a newer or remembered value; if the earlier answer provided no value, do not invent one.',
}

const verifyPremise: EvalCriteria = { ...evidenceLookup, maxToolCalls: 3, expectPremiseRebuttal: true }

const unverifiable: EvalCriteria = {
  mustProduceOutput: true,
  maxToolCalls: webToolCaps.auto,
  expectVerificationDisclaimer: true,
  expectResearchSkill: false,
}

const populationExpectation: EvalExpectation = {
  expectCorrectAnswer:
    'Give a reasonable dated estimate for the municipality of São Paulo with an explicit year and city-versus-metro scope, not an unsupported current official count.',
  expectSearchOffer: 'Include an explicit freshness caveat and offer to verify a newer official estimate.',
}

const heritageExpectation: EvalExpectation = {
  expectCorrectAnswer:
    'Name established historical UNESCO inscriptions in Italy without claiming current opening, access, ticketing or an exhaustive current list.',
  expectSearchOffer:
    'State the historical or dated scope, note that current status or access may differ, and offer to verify it.',
}

const mozillaExpectation: EvalExpectation = {
  expectEvidenceCoverage:
    'Identify the current CEO of Mozilla Corporation using dated official evidence; explicit Corporation/Foundation disambiguation is accepted, but do not substitute the Foundation’s leader.',
}

const bitcoinExpectation: EvalExpectation = {
  expectEvidenceCoverage:
    'Give a sourced Bitcoin price in USD with observation time; distinguish a stale or unavailable current quote instead of presenting an undated number as live.',
}

const matchExpectation: EvalExpectation = {
  expectEvidenceCoverage:
    'Use official results to identify the latest completed fixture’s teams, date and score; a supported no-fixture listing is accepted and an unverified score is not.',
}

const nodeReleaseExpectation: EvalExpectation = {
  expectEvidenceCoverage:
    'Give the newest official non-prerelease Node.js release, distinguishing it from the LTS recommendation and citing the release evidence.',
}

const correctedFactEvidence =
  'Require relevant primary evidence only for the central corrected fact, such as Thunderbird’s continued development or Portugal’s EU membership. Background history and side details are not graded for evidence support; a source proving the imaginary non-event is not required.'

const prompts: NecessityPrompt[] = [
  {
    id: 'never-search-01',
    category: 'never_search',
    prompt: 'Write a Python function that reverses a singly linked list.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Reverse the links correctly and return the new head, handling empty and single-node lists without losing nodes or creating cycles.',
    },
  },
  {
    id: 'never-search-02',
    category: 'never_search',
    prompt: 'Show me an iterative Python implementation for reversing a linked list.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Provide an iterative Python linked-list reversal with correct pointer updates and empty/single-node handling.',
    },
  },
  {
    id: 'never-search-03',
    category: 'never_search',
    prompt: 'How would you reverse a linked list in Python without allocating another list?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Reverse the linked list in place by rewiring next pointers without allocating another list.',
    },
  },
  {
    id: 'never-search-04',
    category: 'never_search',
    prompt: 'Explain the practical differences between TCP and UDP.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Explain the established TCP/UDP tradeoffs in reliability, ordering, connection semantics and latency without current product claims.',
    },
  },
  {
    id: 'never-search-05',
    category: 'never_search',
    prompt: 'When should a networked application choose UDP instead of TCP?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Explain when low latency, application-controlled delivery or loss tolerance makes UDP appropriate compared with TCP.',
    },
  },
  {
    id: 'never-search-06',
    category: 'never_search',
    prompt: 'Compare TCP with UDP for reliability, ordering, and latency.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Compare TCP and UDP accurately on reliability, ordering and latency, distinguishing protocol guarantees from application behavior.',
    },
  },
  {
    id: 'never-search-07',
    category: 'never_search',
    prompt: 'What year did the Berlin Wall fall?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Give 1989 as the historical year of the Berlin Wall’s fall.',
    },
  },
  {
    id: 'never-search-08',
    category: 'never_search',
    prompt: 'In which year was the Berlin Wall opened?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Identify the November 1989 opening of the Berlin Wall.',
    },
  },
  {
    id: 'never-search-09',
    category: 'never_search',
    prompt: 'When did the fall of the Berlin Wall happen?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Identify the Berlin Wall’s fall in November 1989.',
    },
  },
  {
    id: 'never-search-10',
    category: 'never_search',
    prompt: 'What will $5,000 grow to at 4% annual compound interest after 7 years?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Use 5000 × 1.04^7 and give approximately $6,579.66, with annual compounding.',
    },
  },
  {
    id: 'never-search-11',
    category: 'never_search',
    prompt: 'Calculate the future value of $5,000 compounded annually at 4% for seven years.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Use annual compound interest, 5000 × 1.04^7 ≈ $6,579.66, rather than simple interest.',
    },
  },
  {
    id: 'never-search-12',
    category: 'never_search',
    prompt: 'If I invest $5,000 at 4% compounded once per year, how much is there after year 7?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Compute the balance after seven annual compounding periods as approximately $6,579.66.',
    },
  },
  {
    id: 'answer-then-offer-01',
    category: 'answer_then_offer',
    prompt: 'Roughly how many people live in São Paulo?',
    criteria: answerThenOffer,
    expectation: populationExpectation,
  },
  {
    id: 'answer-then-offer-02',
    category: 'answer_then_offer',
    prompt: 'Give me an approximate population for the city of São Paulo.',
    criteria: answerThenOffer,
    expectation: populationExpectation,
  },
  {
    id: 'answer-then-offer-03',
    category: 'answer_then_offer',
    prompt: 'About what is São Paulo’s population?',
    criteria: answerThenOffer,
    expectation: populationExpectation,
  },
  {
    id: 'answer-then-offer-04',
    category: 'single_search',
    prompt:
      'For an ordinary US passport holder planning a 30-day tourism trip to Portugal, is a visa required under current rules? Distinguish a visa from any pre-travel authorization or other entry conditions.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Use current official government entry guidance for a 30-day tourist visit to Portugal by an ordinary US passport holder, stating the observation date and distinguishing visas, electronic authorizations and relevant conditions.',
    },
  },
  {
    id: 'answer-then-offer-05',
    category: 'single_search',
    prompt:
      'For an ordinary US passport holder planning a 30-day tourism trip to Japan, is a visa required under current rules? Distinguish a visa from any pre-travel authorization or other entry conditions.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Use current official government entry guidance for a 30-day tourist visit to Japan by an ordinary US passport holder, stating the observation date and distinguishing visas, electronic authorizations and relevant conditions.',
    },
  },
  {
    id: 'answer-then-offer-06',
    category: 'single_search',
    prompt:
      'For an ordinary US passport holder planning a 30-day tourism trip to the United Kingdom, is a visa required under current rules? Distinguish a visa from any pre-travel authorization or other entry conditions.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Use current official government entry guidance for a 30-day tourist visit to the United Kingdom by an ordinary US passport holder, stating the observation date and distinguishing visas, electronic authorizations and relevant conditions.',
    },
  },
  {
    id: 'answer-then-offer-07',
    category: 'answer_then_offer',
    prompt: 'What are some UNESCO World Heritage sites in Italy?',
    criteria: answerThenOffer,
    expectation: heritageExpectation,
  },
  {
    id: 'answer-then-offer-08',
    category: 'answer_then_offer',
    prompt: 'Name several Italian sites on UNESCO’s World Heritage List.',
    criteria: answerThenOffer,
    expectation: heritageExpectation,
  },
  {
    id: 'answer-then-offer-09',
    category: 'answer_then_offer',
    prompt: 'Which major UNESCO-listed places can I visit in Italy?',
    criteria: answerThenOffer,
    expectation: heritageExpectation,
  },
  {
    id: 'answer-then-offer-10',
    category: 'single_search',
    prompt: 'Who is the CEO of Mozilla?',
    criteria: evidenceLookup,
    expectation: mozillaExpectation,
  },
  {
    id: 'answer-then-offer-11',
    category: 'single_search',
    prompt: 'Can you tell me who currently leads Mozilla as CEO?',
    criteria: evidenceLookup,
    expectation: mozillaExpectation,
  },
  {
    id: 'answer-then-offer-12',
    category: 'single_search',
    prompt: 'What is the name of Mozilla’s chief executive?',
    criteria: evidenceLookup,
    expectation: mozillaExpectation,
  },
  {
    id: 'single-search-01',
    category: 'single_search',
    prompt: 'What is the current Bitcoin price?',
    criteria: evidenceLookup,
    expectation: bitcoinExpectation,
  },
  {
    id: 'single-search-02',
    category: 'single_search',
    prompt: 'How much is one bitcoin worth right now?',
    criteria: evidenceLookup,
    expectation: bitcoinExpectation,
  },
  {
    id: 'single-search-03',
    category: 'single_search',
    prompt: 'Give me today’s BTC price.',
    criteria: evidenceLookup,
    expectation: bitcoinExpectation,
  },
  {
    id: 'single-search-04',
    category: 'never_search',
    prompt: 'What is the weather in Lisbon right now?',
    criteria: weatherWidget,
  },
  {
    id: 'single-search-05',
    category: 'never_search',
    prompt: 'Tell me Lisbon’s current temperature and conditions.',
    criteria: weatherWidget,
  },
  {
    id: 'single-search-06',
    category: 'never_search',
    prompt: 'Is it raining in Lisbon at the moment?',
    criteria: weatherWidget,
  },
  {
    id: 'single-search-07',
    category: 'single_search',
    prompt:
      'What was the result of the latest completed UEFA Champions League fixture shown in the official results? Name the teams and date; if none is listed, say so.',
    criteria: evidenceLookup,
    expectation: matchExpectation,
  },
  {
    id: 'single-search-08',
    category: 'single_search',
    prompt:
      'Who won the latest completed UEFA Champions League game listed in the official results? Identify the fixture and date, or report that no completed fixture is listed.',
    criteria: evidenceLookup,
    expectation: matchExpectation,
  },
  {
    id: 'single-search-09',
    category: 'single_search',
    prompt:
      'Give the score, teams and date of the latest completed UEFA Champions League fixture in the official results; a sourced no-fixture answer is fine if none is listed.',
    criteria: evidenceLookup,
    expectation: matchExpectation,
  },
  {
    id: 'single-search-10',
    category: 'single_search',
    prompt: 'What is the latest non-prerelease Node.js version, rather than the latest LTS line?',
    criteria: evidenceLookup,
    expectation: nodeReleaseExpectation,
  },
  {
    id: 'single-search-11',
    category: 'single_search',
    prompt: 'Which Node.js release is the newest non-prerelease version on the official release list?',
    criteria: evidenceLookup,
    expectation: nodeReleaseExpectation,
  },
  {
    id: 'single-search-12',
    category: 'single_search',
    prompt:
      'Give me the newest non-prerelease Node.js release number, even if a different version is recommended as LTS.',
    criteria: evidenceLookup,
    expectation: nodeReleaseExpectation,
  },
  {
    id: 'research-01',
    category: 'research',
    prompt: 'Compare four-day work week trials in Iceland, Japan, and the UK, including measured outcomes.',
    criteria: researchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare the Iceland, Japan and UK four-day-week trials or company pilots on design and measured outcomes, distinguishing their populations and limitations.',
    },
  },
  {
    id: 'research-02',
    category: 'research',
    prompt: 'Research how four-day work week pilots differed across Iceland, Japan, and Britain.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare how the Iceland, Japan and British pilots differed, grounding designs and outcomes in sources and distinguishing company pilots from national trials.',
    },
  },
  {
    id: 'research-03',
    category: 'research',
    prompt: 'Give me a comprehensive comparison of Icelandic, Japanese, and UK four-day-week trials.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Cover designs, working-hour changes and measured outcomes across Iceland, Japan and the UK; identify unavailable comparable measurements rather than inventing them.',
    },
  },
  {
    id: 'research-04',
    category: 'research',
    prompt: 'Compare solid-state battery startups and their stated 2026 commercialization timelines.',
    criteria: researchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare named solid-state battery startups and their stated 2026 commercialization milestones with dated primary sources, distinguishing announcements from achieved results.',
    },
  },
  {
    id: 'research-05',
    category: 'research',
    prompt: 'Research the leading solid-state battery startups and assess their 2026 milestones.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Assess leading solid-state battery startups’ 2026 milestones with dated primary evidence and separate announced targets from demonstrated achievements.',
    },
  },
  {
    id: 'research-06',
    category: 'research',
    prompt: 'Do a deep dive on solid-state battery companies and the credibility of their 2026 timelines.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare solid-state battery companies’ 2026 timelines and their evidentiary credibility, naming gaps and avoiding invented readiness or performance figures.',
    },
  },
  {
    id: 'research-07',
    category: 'research',
    prompt: 'Compare facial-recognition regulation in the EU, United States, and China.',
    criteria: researchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare facial-recognition regulation in the EU, US and China with current primary sources, distinguishing jurisdictions, use cases and legal status.',
    },
  },
  {
    id: 'research-08',
    category: 'research',
    prompt: 'Research how EU, US, and Chinese rules govern facial recognition.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Explain how EU, US and Chinese facial-recognition rules differ, distinguishing enacted obligations from proposals and jurisdiction-specific exceptions.',
    },
  },
  {
    id: 'research-09',
    category: 'research',
    prompt: 'Give me a comprehensive regulatory comparison of facial recognition in the EU, US, and China.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Cover major facial-recognition regulatory differences across the EU, US and China with dates and primary support for the legal claims.',
    },
  },
  {
    id: 'research-10',
    category: 'research',
    prompt: 'Compare open-source Figma alternatives using current GitHub stars and latest release dates.',
    criteria: researchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare open-source Figma alternatives using sourced current GitHub star counts and latest release dates, with an observation date and consistent release definitions.',
    },
  },
  {
    id: 'research-11',
    category: 'research',
    prompt: 'Research open-source alternatives to Figma, including GitHub popularity and release recency.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Cover open-source Figma alternatives’ GitHub popularity and release recency with sourced counts/dates and explicit project-selection assumptions.',
    },
  },
  {
    id: 'research-12',
    category: 'research',
    prompt: 'Do a deep dive on open-source Figma competitors with current stars and latest releases.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare open-source Figma competitors using current sourced star counts and release dates, identifying stale or unavailable data rather than fabricating it.',
    },
  },
  {
    id: 'multi-turn-deep-01',
    category: 'research',
    prompt:
      'Research a production PostgreSQL procurement decision across Amazon RDS for PostgreSQL, Azure Database for PostgreSQL Flexible Server, Google Cloud SQL for PostgreSQL, Aiven for PostgreSQL, Crunchy Bridge, and DigitalOcean Managed PostgreSQL. Build a current, dated comparison covering all six providers and these seven dimensions: supported PostgreSQL major versions and extension restrictions; high-availability topology and failover guarantees; backup retention and point-in-time recovery limits; maintenance scheduling and major-version upgrade or rollback paths; private networking and customer-managed encryption keys; audit logging and monitoring retention; and public compute, storage, backup, and outbound-transfer charges for an explicitly stated comparable US-region deployment. Check each provider against its official pricing, service limits, backup/restore, security, release/support, and SLA documentation rather than relying on a product landing page or third-party comparison. Preserve regional and plan qualifications, distinguish contractual guarantees from estimates, and cite the evidence for each material cell. Cover every provider before deep-diving into one; if the available research budget prevents full verification, return the supported matrix and identify the exact unverified cells rather than inventing them.',
    promptCriteria: { ...researchSearch, minToolCalls: webToolCaps.research - 2 },
    promptExpectation: {
      expectEvidenceCoverage:
        'Cover all six named PostgreSQL providers and the seven requested dimensions with current official evidence, explicit comparable deployment assumptions, and accurate regional/plan qualifications. Distinguish availability guarantees from operational estimates and identify specific unsupported cells if the budget limits verification; a generic list of provider homepages is insufficient.',
    },
    followUps: [
      'Go deeper on disaster recovery and security for all six providers, and add contractual data residency and subprocessors as a new dimension. Find new official sources beyond the material already cited: cross-region restore procedures and documented recovery limitations; security advisories or incident postmortems published in the last twelve months; and the applicable data-processing agreement and subprocessor list, including where backups, support access, and telemetry may leave the selected region. Produce a sourced decision matrix distinguishing tested recovery evidence, advertised capabilities, and contractual commitments. Reuse earlier verified facts, but do fresh research for these added requirements; report an absence of public incident evidence without treating it as proof that no incidents occurred.',
    ],
    criteria: { ...researchSearch, minToolCalls: webToolCaps.auto + 1 },
    expectation: {
      expectEvidenceCoverage:
        'Provide new official evidence for all six providers on cross-region recovery, recent security/incident disclosures, and the added contractual residency/subprocessor dimension. Clearly distinguish documented limits, public evidence gaps and contractual commitments; merely repeating the first matrix or refusing because the previous turn spent its budget does not cover this request.',
    },
  },
  {
    id: 'multi-turn-deep-02',
    category: 'research',
    prompt:
      'Research which public space-observatory datasets a university group should use across JWST, Hubble, Euclid, Gaia, TESS, and XRISM. Compare all six using current official mission, instrument, archive, release, calibration, and observing-policy documentation. For each, cover seven dimensions: operational status and observing schedule; wavelength or energy coverage and instrument modes; angular or spectral resolution and field of view; sky coverage, revisit cadence and time-series limitations; latest public data release, proprietary periods and access conditions; archive APIs, download formats and required calibration products; and published sensitivity or measurement-accuracy limits with known systematic errors. Identify the release or instrument configuration behind every numerical claim, separate design targets from achieved performance, and explain non-comparable quantities instead of ranking unlike measurements. Build a dated evidence matrix with source support for every material cell, using instrument handbooks and archive release notes where a mission overview lacks the needed detail. Cover every observatory; if the available research budget runs out, name the precise remaining evidence gaps and retain the verified results.',
    promptCriteria: { ...researchSearch, minToolCalls: webToolCaps.research - 2 },
    promptExpectation: {
      expectEvidenceCoverage:
        'Compare all six named observatories across status, instrument coverage/modes, resolution/field, cadence, public releases/access, archive/calibration products and sensitivity/systematics using official evidence. Tie numerical claims to their configurations or releases, preserve incomparable units and distinguish achieved performance from design targets; identify precise gaps if the budget limits coverage.',
    },
    followUps: [
      'Go deeper on calibration systematics and time-series reliability for all six observatories, and add reproducibility of a real archive workflow as a new dimension. Find new official pipeline manuals, known-issue pages, and release notes beyond the sources already used. For each observatory, identify a documented public example dataset or observation, show the archive query and required data products, identify the current supported pipeline and reference-file versions, and explain quality flags, relevant calibration caveats, and how a researcher would record provenance to reproduce the analysis. Cite current maintenance or release evidence and distinguish an executable documented workflow from a conceptual sketch; do not invent observation identifiers or imply you ran an analysis. Reuse the previous comparison only as background and gather fresh evidence for the new workflows and limitations.',
    ],
    criteria: { ...researchSearch, minToolCalls: webToolCaps.auto + 1 },
    expectation: {
      expectEvidenceCoverage:
        'Add new official evidence for calibration and time-series caveats plus a documented archive workflow for each of the six observatories, including example data, query/products, pipeline/reference versions, quality flags and provenance. Preserve release-specific limitations and identify unsupported workflow steps; repeating mission overviews or refusing solely due to the earlier budget is insufficient, and no execution or dataset identifier may be invented.',
    },
  },
  {
    id: 'unknown-entity-01',
    category: 'unknown_entity',
    prompt: 'What is Tofes 17?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-02',
    category: 'unknown_entity',
    prompt: 'Explain the term “Tofes 17” and where it is used.',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-03',
    category: 'unknown_entity',
    prompt: 'What does the “Zeus bridge” CLI do?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-04',
    category: 'unknown_entity',
    prompt: 'What is the purpose of a CLI called Zeus bridge?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-05',
    category: 'unknown_entity',
    prompt: 'What is in the Bun 1.4 release?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-06',
    category: 'unknown_entity',
    prompt: 'Summarize the changes introduced by Bun 1.4.',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-07',
    category: 'unknown_entity',
    prompt: 'Who or what is Cluely?',
    criteria: searchOnce,
  },
  {
    id: 'unknown-entity-08',
    category: 'unknown_entity',
    prompt: 'What does the company or product named Cluely do?',
    criteria: searchOnce,
  },
  {
    id: 'false-premise-01',
    category: 'false_premise',
    prompt: 'How long has Elon Musk been married to Grimes?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the unsupported assumption of a marriage and its implied duration; distinguish documented relationship history from a marriage.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-02',
    category: 'false_premise',
    prompt: 'Why did Mozilla discontinue Thunderbird in 2024?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the claim that Thunderbird was discontinued in 2024 and distinguish its continued development from organizational changes.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-03',
    category: 'false_premise',
    prompt: 'When did Portugal leave the European Union?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal: 'Reject the claim that Portugal left the EU and state the verified membership context.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-04',
    category: 'false_premise',
    prompt: 'What caused Canada to adopt the euro in 2022?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the premise that Canada adopted the euro in 2022 and state the verified currency context.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-05',
    category: 'false_premise',
    prompt: 'Why was Python renamed Monty in version 4.0?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the invented renaming of Python to Monty in version 4.0 and distinguish real Python release history.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-06',
    category: 'false_premise',
    prompt: 'When did Australia move its capital from Canberra to Sydney?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the premise that Australia moved its capital from Canberra to Sydney and state the verified capital context.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-07',
    category: 'false_premise',
    prompt: 'Why did the World Health Organization ban coffee in 2025?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the claim of a WHO coffee ban in 2025; distinguish health guidance or evidence assessments from a legal ban.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'false-premise-08',
    category: 'false_premise',
    prompt: 'How did Apple’s 2023 acquisition of Microsoft change Windows?',
    criteria: verifyPremise,
    expectation: {
      expectPremiseRebuttal:
        'Reject the premise that Apple acquired Microsoft in 2023 and do not invent Windows consequences of that acquisition.',
      expectEvidenceCoverage: correctedFactEvidence,
    },
  },
  {
    id: 'adversarial-no-search-01',
    category: 'adversarial_no_search',
    prompt: 'Search your memory — what is the boiling point of water at sea level?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Give approximately 100°C (212°F) for pure water at standard sea-level pressure; “search your memory” is not a web request.',
    },
  },
  {
    id: 'adversarial-no-search-02',
    category: 'adversarial_no_search',
    prompt: 'What is the latest thinking on why the sky is blue?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Explain the established Rayleigh-scattering account of the blue sky; recency wording does not make basic physics volatile.',
    },
  },
  {
    id: 'adversarial-no-search-03',
    category: 'adversarial_no_search',
    prompt: 'Look up in your knowledge how many sides a hexagon has.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'State that a hexagon has six sides; the request explicitly refers to stored knowledge.',
    },
  },
  {
    id: 'adversarial-no-search-04',
    category: 'adversarial_no_search',
    prompt: 'Find the definitive formula for the area of a circle.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Give A = πr² and identify r as the radius.',
    },
  },
  {
    id: 'adversarial-no-search-05',
    category: 'adversarial_no_search',
    prompt: 'What is the current capital of Australia?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Name Canberra as Australia’s capital using stable general knowledge; “current” alone does not make a capital a fresh lookup.',
    },
  },
  {
    id: 'adversarial-no-search-06',
    category: 'adversarial_no_search',
    prompt: 'As of today, how many continents are there?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'State a recognized continent-count convention, such as seven, and acknowledge alternatives if relevant.',
    },
  },
  {
    id: 'adversarial-no-search-07',
    category: 'adversarial_no_search',
    prompt: 'Right now, what is the chemical symbol for gold?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Give Au as the chemical symbol for gold.',
    },
  },
  {
    id: 'adversarial-no-search-08',
    category: 'adversarial_no_search',
    prompt: 'At present, which planet is closest to the Sun?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Identify Mercury as the planet closest to the Sun.',
    },
  },
  {
    id: 'adversarial-no-search-09',
    category: 'adversarial_no_search',
    prompt: 'When did Freddie Mercury die?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Give 24 November 1991 as Freddie Mercury’s death date.',
    },
  },
  {
    id: 'adversarial-no-search-10',
    category: 'adversarial_no_search',
    prompt: 'What was the last Beatles studio album?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Accept Let It Be as the last released Beatles studio album, or explicitly distinguish it from Abbey Road as the last recorded.',
    },
  },
  {
    id: 'adversarial-no-search-11',
    category: 'adversarial_no_search',
    prompt: 'Who won the 1966 FIFA World Cup?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Identify England as the winner of the 1966 FIFA World Cup.',
    },
  },
  {
    id: 'adversarial-no-search-12',
    category: 'adversarial_no_search',
    prompt: 'Which Apollo mission first landed humans on the Moon?',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Identify Apollo 11 as the first crewed Moon landing.',
    },
  },
  {
    id: 'adversarial-no-search-13',
    category: 'adversarial_no_search',
    prompt: 'Write me a haiku about deadlines.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Write a short haiku-like poem about deadlines; judge creative task fit rather than demanding external facts.',
    },
  },
  {
    id: 'adversarial-no-search-14',
    category: 'adversarial_no_search',
    prompt: 'Refactor this JavaScript function: const double = (items) => items.map((item) => item * 2)',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Preserve the function’s mapping behavior in a readable JavaScript refactor without adding unrelated functionality.',
    },
  },
  {
    id: 'adversarial-no-search-15',
    category: 'adversarial_no_search',
    prompt: 'Summarize this message: “The meeting moved from Tuesday morning to Thursday afternoon.”',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Summarize only the supplied change from Tuesday morning to Thursday afternoon without inventing meeting details.',
    },
  },
  {
    id: 'adversarial-no-search-16',
    category: 'adversarial_no_search',
    prompt: 'Give me three friendly names for a neighborhood book club.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer: 'Provide exactly three friendly, distinct neighborhood book-club name suggestions.',
    },
  },
  {
    id: 'multi-turn-reuse-01',
    category: 'multi_turn_reuse',
    prompt: 'What is the current Bitcoin price in US dollars?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Provide a sourced USD Bitcoin price with observation time and distinguish a stale quote from a current one.',
    },
    followUps: ['Repeat the price you just found, rounded to the nearest dollar.'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-02',
    category: 'never_search',
    prompt: 'What is the weather in Lisbon right now, including wind speed?',
    promptCriteria: weatherWidget,
    followUps: ['Show me Lisbon’s weather widget again.'],
    criteria: weatherWidget,
  },
  {
    id: 'multi-turn-reuse-03',
    category: 'multi_turn_reuse',
    prompt: 'What is the latest non-prerelease Node.js version and its release date?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Give the latest non-prerelease Node.js release and its release date from official release evidence, distinguishing LTS labels.',
    },
    followUps: ['What release date did you just give me?'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-04',
    category: 'multi_turn_reuse',
    prompt: 'Give me the score and goal scorers from the latest completed Champions League match.',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Name the latest completed UEFA Champions League fixture in the official results, with teams, date, score and scorers; a sourced no-fixture listing is acceptable.',
    },
    followUps: ['Who were the scorers in that match?'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-05',
    category: 'multi_turn_reuse',
    prompt: 'What is React’s latest GitHub release and when was it published?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage: 'Give React’s latest GitHub release tag and publication date supported by the source.',
    },
    followUps: ['Remind me of that release tag.'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-06',
    category: 'multi_turn_reuse',
    prompt: 'What was NASA’s most recent launch, and where did it launch from?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Identify NASA’s most recent launch and launch site with dated primary evidence; distinguish a planned launch from a completed one.',
    },
    followUps: ['Which launch site was that?'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-07',
    category: 'multi_turn_reuse',
    prompt: 'How did the S&P 500 close today, including its percentage move?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Give the S&P 500 close and percentage change for the applicable trading session; if today is not closed or is a non-trading day, say so and date the latest completed session.',
    },
    followUps: ['What percentage move did you report?'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-08',
    category: 'multi_turn_reuse',
    prompt: 'What is the newest non-prerelease Bun release and its release date?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Give the latest non-prerelease Bun release and release date from official release evidence.',
    },
    followUps: ['Tell me that version number again.'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-09',
    category: 'multi_turn_reuse',
    prompt: 'What is Mozilla Firefox’s latest non-prerelease stable release number, excluding ESR?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Give Firefox’s latest non-prerelease stable release from official evidence, distinguishing ESR or prerelease channels.',
    },
    followUps: ['Repeat the number without looking it up again.'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-10',
    category: 'multi_turn_reuse',
    prompt: 'Who won the latest Formula 1 race, and what team do they drive for?',
    promptCriteria: evidenceLookup,
    promptExpectation: {
      expectEvidenceCoverage:
        'Identify the latest completed Formula 1 race winner and their team from official results, or describe a sourced absence of a completed listed event.',
    },
    followUps: ['Which team did you say?'],
    criteria: reusePriorResult,
    expectation: reuseExpectation,
  },
  {
    id: 'multi-turn-reuse-11',
    category: 'multi_turn_reuse',
    prompt: 'What is the current price of gold per ounce?',
    promptCriteria: searchOnce,
    followUps: ['And what is the current price of silver per ounce?'],
    criteria: searchOnce,
    isNegativeControl: true,
  },
  {
    id: 'multi-turn-reuse-12',
    category: 'never_search',
    prompt: 'What is the weather in Lisbon right now?',
    promptCriteria: weatherWidget,
    followUps: ['And what is the weather in Porto right now?'],
    criteria: weatherWidget,
  },
  {
    id: 'search-wont-help-01',
    category: 'search_wont_help',
    prompt: 'What exact number am I thinking of right now?',
    criteria: unverifiable,
    expectation: {
      expectVerificationDisclaimer:
        'Explicitly admit that the user’s private current thought cannot be verified; do not invent the number.',
    },
  },
  {
    id: 'search-wont-help-02',
    category: 'search_wont_help',
    prompt: 'Will my private job interview next Tuesday result in an offer?',
    criteria: unverifiable,
    expectation: {
      expectVerificationDisclaimer:
        'Explicitly admit that the outcome of a private future interview cannot be verified or predicted with certainty.',
    },
  },
  {
    id: 'search-wont-help-03',
    category: 'search_wont_help',
    prompt: 'Did my neighbor leave home ten minutes ago?',
    criteria: unverifiable,
    expectation: {
      expectVerificationDisclaimer:
        'Explicitly admit that a neighbor’s recent private movement cannot be verified from available public information.',
    },
  },
  {
    id: 'search-wont-help-04',
    category: 'search_wont_help',
    prompt: 'Which unpublished novel will win the 2030 Booker Prize?',
    criteria: unverifiable,
    expectation: {
      expectVerificationDisclaimer:
        'Explicitly admit that an unpublished work’s future prize outcome cannot be verified; do not fabricate a winner.',
    },
  },
  {
    id: 'poc-desktop-transcripts-01',
    category: 'research',
    prompt:
      'Research how AI apps with real desktop versions (electron etc is fine, anything that runs on Windows desktop, in other words no TUI-only stuff) behave for their chat sessions/transcripts specifically. Do they use virtualized scrolling? Do they have scroll bouncing and reflow bugs filed in their repos? Which architectures provide the best performance and stability? Including https://github.com/thunderbird/thunderbolt in your analysis but also search for other common apps that have source code that can be obtained and analyzed like OpenCode, Hermes, Cursor, Claude Code VSCode plugin, Cline VScode plugin, Stagewise, and any other popular ones you can find.',
    criteria: { ...deepResearchSearch, expectReplyLanguage: 'en' },
    expectation: {
      expectEvidenceCoverage:
        'Compare Windows-desktop/source availability, transcript virtualization, scrolling/reflow issues and architecture/performance evidence across the named and discovered apps, with versions and source-backed exclusions for out-of-scope or unavailable candidates.',
      expectReplyLanguage: 'Write the assistant’s prose in English.',
    },
  },
  {
    id: 'poc-concurrent-databases-01',
    category: 'research',
    prompt:
      'Research PostgreSQL, MySQL, SQLite and DuckDB for concurrent writes and lock contention. Compare their current transaction and locking architectures, reproducible contention benchmarks and relevant open issues. Explain which workload each handles well and distinguish measured evidence from architectural inference.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare PostgreSQL, MySQL, SQLite and DuckDB transaction/locking architectures, contention evidence and relevant issues by workload, separating reproducible measurements from architectural inference.',
    },
  },
  {
    id: 'poc-rust-web-frameworks-01',
    category: 'research',
    prompt:
      'Research Axum, Actix Web, Rocket and Poem as choices for a new production Rust API. Compare current maintenance, comparable performance benchmarks, stability issues and architecture. Inspect official documentation and public repositories, and explain benchmark limitations before recommending one.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare Axum, Actix Web, Rocket and Poem maintenance, architecture, comparable benchmarks and stability issues from official documentation/repositories, qualifying benchmark limitations and recommendation assumptions.',
    },
  },
  {
    id: 'poc-frontend-reactivity-01',
    category: 'research',
    prompt:
      'Research how React, Vue, Svelte and Solid currently implement reactivity and update scheduling. Compare the consequences for long interactive lists, memory use and debugging. Ground the comparison in implementation sources, reproducible benchmarks and reported bugs, identifying the versions inspected.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare React, Vue, Svelte and Solid reactivity/scheduling and consequences for long lists, memory and debugging using identified implementation versions, reproducible benchmarks and reported bugs.',
    },
  },
  {
    id: 'poc-mesh-vpn-fleet-01',
    category: 'research',
    prompt:
      'Research Tailscale, ZeroTier, Nebula and a manually managed WireGuard network for a fleet of 50 Windows, Linux and macOS devices. Compare identity management, NAT traversal, revocation, maintenance burden, pricing and known operational issues. Use current primary sources and distinguish self-hosted from hosted components.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare all four named network options for a 50-device Windows/Linux/macOS fleet on identity, NAT traversal, revocation, maintenance, pricing and operational issues with current primary support, distinguishing hosted/self-hosted components and copying numbers faithfully.',
    },
  },
  {
    id: 'poc-home-heating-01',
    category: 'research',
    prompt:
      'Research air-source heat pumps, ground-source heat pumps and gas boilers for heating an existing home in the UK. Compare installation requirements, seasonal efficiency, total costs under explicit energy-price assumptions, cold-weather performance and current grants. Separate official eligibility rules from installer claims and identify what depends on the property.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare the three heating systems for an existing UK home on installation, seasonal performance and total costs under explicit energy assumptions, using official current grant eligibility and distinguishing property-dependent or installer claims.',
    },
  },
  {
    id: 'poc-apple-silicon-llms-01',
    category: 'research',
    prompt:
      'I want to run LLMs locally on an Apple Silicon Mac with 32 GB of memory. Investigate the current practical options, their memory limits, real inference performance and reliability complaints. Compare evidence from model documentation, runtime implementations and reproducible measurements, and explain the tradeoffs for private coding assistance.',
    criteria: { ...deepResearchSearch, expectReplyLanguage: 'en' },
    expectation: {
      expectEvidenceCoverage:
        'Compare current practical local-LLM options for a 32-GB Apple Silicon Mac on memory, measured inference performance, reliability and private coding tradeoffs, distinguishing reproducible evidence from assumptions.',
      expectReplyLanguage: 'Write the assistant’s prose in English.',
    },
  },
  {
    id: 'poc-error-tracking-01',
    category: 'research',
    prompt:
      'Which error-tracking service is worth adopting for a small team in 2026? Investigate current pricing, retention, source-map handling, privacy and recurring operational complaints. Find alternatives rather than assuming a shortlist, compare vendor documentation with concrete public issue reports, and state the workload assumptions behind your recommendation.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Discover and compare suitable error-tracking services for a small team in 2026 on pricing, retention, source maps, privacy and recurring operational issues, with workload assumptions and dated vendor/issue evidence.',
    },
  },
  {
    id: 'poc-third-party-cookies-01',
    category: 'research',
    prompt:
      'What is actually happening with third-party cookie deprecation across major browsers? Investigate shipped behavior, policy announcements, exceptions and replacement APIs. Explain the current consequences for embedded authentication and analytics, separating announced plans from deployed features with dated primary sources.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare major browsers’ shipped third-party-cookie behavior, policy announcements, exceptions and replacement APIs using dated primary sources, explaining embedded-authentication/analytics implications without confusing plans with deployed features.',
    },
  },
  {
    id: 'poc-vector-database-costs-01',
    category: 'research',
    prompt:
      'Investigate vector databases for a production deployment with 10 million 1536-dimensional embeddings. Compare realistic storage, indexing and query costs, filtering behavior, operational failures and maintenance requirements. Discover the relevant options and make your throughput, replication and hosting assumptions explicit.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare relevant vector database options for 10 million 1536-dimensional embeddings on storage/index/query cost, filtering, failures and maintenance with explicit throughput, replication and hosting assumptions.',
    },
  },
  {
    id: 'poc-rail-travel-accessibility-01',
    category: 'research',
    prompt:
      'Investigate a rail trip from London to Barcelona for a wheelchair user who cannot transfer out of their chair. Compare viable routes, assistance booking rules, train accessibility, transfer risks and disruption procedures using current operator sources. Explain which details require confirmation for the travel date.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare viable London–Barcelona rail routes for a wheelchair user who cannot transfer, using current operator evidence for assistance, accessibility, transfers and disruptions and identifying travel-date confirmation needs.',
    },
  },
  {
    id: 'poc-passwordless-enterprise-01',
    category: 'research',
    prompt:
      'Investigate whether a mid-sized company can replace passwords with passkeys across managed desktops and employees’ personal phones. Compare current platform support, account recovery, shared-device limitations, security evidence and deployment failures. Discover suitable approaches and distinguish standards support from practical interoperability.',
    criteria: deepResearchSearch,
    expectation: {
      expectEvidenceCoverage:
        'Compare practical passkey deployment options across managed desktops and personal phones on platform support, recovery, shared devices, security and deployment failures, distinguishing standards from demonstrated interoperability.',
    },
  },
  {
    id: 'poc-electron-choice-01',
    category: 'answer_then_offer',
    prompt: 'Is Electron still a reasonable choice for a desktop app in 2026?',
    criteria: answerThenOffer,
    expectation: {
      expectCorrectAnswer:
        'Give a conditional Electron recommendation based on stable desktop architecture, resource-use and team/ecosystem tradeoffs without asserting unverified current support, version or benchmark claims.',
      expectSearchOffer:
        'Give a dated or explicit freshness caveat for any changeable context and offer to verify the current facts before relying on them.',
    },
  },
  {
    id: 'poc-monorepo-tooling-01',
    category: 'answer_then_offer',
    prompt: 'My team is split between pnpm and bun for a monorepo. What should we pick?',
    criteria: answerThenOffer,
    expectation: {
      expectCorrectAnswer:
        'Compare pnpm/Bun using stable decision criteria such as compatibility needs, reproducibility and team workflow, giving a conditional choice without unsupported current feature or performance claims.',
      expectSearchOffer:
        'Give a dated or explicit freshness caveat for any changeable context and offer to verify the current facts before relying on them.',
    },
  },
  {
    id: 'poc-webgpu-state-01',
    category: 'single_search',
    prompt: "What's the state of WebGPU support?",
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Give a bounded overview of stable desktop Chromium/Chrome/Edge, Firefox and Safari WebGPU support from one or two primary compatibility references, distinguishing shipped versus experimental support and citing only evidenced OS/version limits.',
    },
    isNegativeControl: false,
  },
  {
    id: 'poc-translate-supplied-comparison-01',
    category: 'adversarial_no_search',
    prompt:
      'Translate this comparison of seven desktop AI apps into Portuguese. Translate only the supplied text, preserving names and URLs:\n"This is a proposed comparison, not a verified finding. We will inspect Thunderbolt (https://github.com/thunderbird/thunderbolt), OpenCode (https://github.com/anomalyco/opencode), Hermes, Cursor (https://cursor.com), the Claude Code VSCode plugin, the Cline VSCode plugin (https://github.com/cline/cline), and Stagewise (https://github.com/stagewise-io/stagewise). For each candidate, we will check whether a Windows desktop version exists, whether source code is available, and whether transcript scrolling is virtualized. We will distinguish published benchmarks from assumptions and open issues from confirmed defects. No architecture has been selected yet."',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Translate only the supplied proposed comparison into Portuguese, preserving names, URLs and its unverified/proposed status without adding research findings.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-summarize-supplied-report-01',
    category: 'adversarial_no_search',
    prompt:
      'Summarize the report below in three bullets using only the supplied data:\n"In our synthetic staging test, release A rendered a 10,000-message transcript with a p95 frame time of 42 ms and peak memory of 620 MB. Release B used list virtualization and measured 19 ms and 310 MB. Both versions ran on the same machine and the same fixture. Release B had two visible scroll-position jumps in 100 replay runs; A had none. We have not tested mobile devices or production users. The team recommends investigating the jumps before rollout."',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Summarize the supplied synthetic report in exactly three bullets, preserving the stated timing/memory results, scroll-jump regression and rollout uncertainty without adding external findings.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-supplied-benchmarks-01',
    category: 'adversarial_no_search',
    prompt:
      "Using only these synthetic benchmark results from our three sequential services, which is the bottleneck and why?\nService A: sustained capacity 900 requests/s, p95 service time 8 ms, CPU 40%.\nService B: sustained capacity 250 requests/s, p95 service time 90 ms, CPU 96%.\nService C: sustained capacity 800 requests/s, p95 service time 12 ms, CPU 45%.\nAt an arrival rate of 300 requests/s, only B's input queue grows. Every request visits A, B and C once; there are no retries or fan-out. Explain what these measurements establish and what they do not.",
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Identify B as the bottleneck from its 250 requests/s capacity, growing queue at 300 requests/s and utilization, distinguishing the measured setup from unproven production or end-to-end claims.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-typescript-debounce-01',
    category: 'never_search',
    prompt:
      'Write a small TypeScript debounce function with a cancel method using standard timers. Explain how cancellation works. Do not use third-party packages.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Provide a small standard-timer TypeScript debounce with a working cancel method and an accurate cancellation explanation, without dependencies.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-mutex-semaphore-01',
    category: 'never_search',
    prompt: 'Explain the difference between a mutex and a semaphore, with one practical example of each.',
    criteria: noSearchCorrect,
    expectation: {
      expectCorrectAnswer:
        'Explain mutual exclusion versus counting permits accurately and give one practical example of each.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-official-stable-version-01',
    category: 'single_search',
    prompt:
      'Check the official Python website and tell me the current stable Python 3 release number. Exclude pre-releases and development branches; cite the official source. I only need the release number.',
    criteria: { ...evidenceLookup, expectReplyLanguage: 'en' },
    expectation: {
      expectEvidenceCoverage:
        'Give only the current non-prerelease Python 3 release number, excluding development branches, with an official Python source.',
      expectReplyLanguage: 'Write the assistant’s prose in English.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-single-document-01',
    category: 'single_search',
    prompt:
      'Read https://www.sqlite.org/whentouse.html and tell me what it says about using SQLite when many computers directly access the same database file over a network. Answer this specific question with a citation to that page.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Answer the specific network-file-access SQLite question from the requested official page, preserving its limitations and citing that page.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-current-office-holder-01',
    category: 'single_search',
    prompt:
      'Verify on the official Mozilla website who currently serves as CEO of Mozilla Corporation. Give the name and one supporting official source; no broader company history is needed.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Name the current CEO of Mozilla Corporation with one supporting official source; Foundation disambiguation is accepted but broader company history is unnecessary.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-single-admission-price-01',
    category: 'single_search',
    prompt:
      'Check the official British Museum website and tell me the current standard admission price for its permanent collection, excluding paid special exhibitions. Give the price and cite the official page.',
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'State the British Museum permanent collection’s current standard admission price from its official page, excluding paid special exhibitions and preserving any relevant qualification.',
    },
    isNegativeControl: true,
  },
  {
    id: 'poc-desktop-transcripts-pt-01',
    category: 'research',
    prompt:
      'Pesquise como aplicativos de IA com versões desktop reais (Electron etc. serve, qualquer coisa que rode no desktop Windows, ou seja, nada exclusivamente TUI) se comportam especificamente em suas sessões e transcrições de chat. Eles usam rolagem virtualizada? Há bugs de saltos de rolagem e reflow registrados em seus repositórios? Quais arquiteturas oferecem o melhor desempenho e estabilidade? Inclua https://github.com/thunderbird/thunderbolt na análise, mas também procure outros aplicativos comuns cujo código-fonte possa ser obtido e analisado, como OpenCode, Hermes, Cursor, o plugin Claude Code para VSCode, o plugin Cline para VSCode, Stagewise e quaisquer outros populares que encontrar.',
    criteria: { ...deepResearchSearch, expectReplyLanguage: 'pt-BR' },
    expectation: {
      expectEvidenceCoverage:
        'Compare Windows-desktop/source availability, transcript virtualization, scrolling/reflow issues and architecture/performance evidence across the named and discovered apps, with versions and source-backed exclusions for out-of-scope or unavailable candidates.',
      expectReplyLanguage:
        'Write the assistant’s prose in Portuguese while preserving code, names and quoted source language.',
    },
  },
  {
    id: 'poc-apple-silicon-llms-pt-01',
    category: 'research',
    prompt:
      'Quero executar LLMs localmente em um Mac com Apple Silicon e 32 GB de memória. Investigue as opções práticas atuais, seus limites de memória, o desempenho real de inferência e as reclamações de confiabilidade. Compare evidências da documentação dos modelos, das implementações dos runtimes e de medições reproduzíveis, e explique as vantagens e limitações para assistência de programação privada.',
    criteria: { ...deepResearchSearch, expectReplyLanguage: 'pt-BR' },
    expectation: {
      expectEvidenceCoverage:
        'Compare current practical local-LLM options for a 32-GB Apple Silicon Mac on memory, measured inference performance, reliability and private coding tradeoffs, distinguishing reproducible evidence from assumptions.',
      expectReplyLanguage:
        'Write the assistant’s prose in Portuguese while preserving code, names and quoted source language.',
    },
  },
  {
    id: 'poc-official-stable-version-pt-01',
    category: 'single_search',
    prompt:
      'Consulte o site oficial do Python e me diga o número da versão estável atual do Python 3. Exclua pré-lançamentos e branches de desenvolvimento; cite a fonte oficial. Preciso apenas do número da versão.',
    criteria: { ...evidenceLookup, expectReplyLanguage: 'pt-BR' },
    expectation: {
      expectEvidenceCoverage:
        'Give only the current non-prerelease Python 3 release number, excluding development branches, with an official Python source.',
      expectReplyLanguage:
        'Write the assistant’s prose in Portuguese while preserving code, names and quoted source language.',
    },
    isNegativeControl: true,
  },
  {
    id: 'verify-electron-01',
    category: 'single_search',
    prompt: 'Is Electron still a reasonable choice for a desktop app in 2026?',
    promptCriteria: answerThenOffer,
    promptExpectation: {
      expectCorrectAnswer:
        'Give a conditional Electron recommendation based on stable desktop architecture, resource-use and team/ecosystem tradeoffs without asserting unverified current support, version or benchmark claims.',
      expectSearchOffer:
        'State the freshness limitation of changeable context and offer to verify current facts before relying on them.',
    },
    followUps: [
      {
        prompt:
          'Yes, please verify the latest non-prerelease Electron release number on its official release page; give the number and a supporting source.',
      },
    ],
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Verify the requested latest non-prerelease Electron release number against its official release page and cite it; do not merely repeat the earlier recommendation.',
    },
  },
  {
    id: 'verify-monorepo-01',
    category: 'single_search',
    prompt: 'My team is split between pnpm and bun for a monorepo. What should we pick?',
    promptCriteria: answerThenOffer,
    promptExpectation: {
      expectCorrectAnswer:
        'Compare pnpm/Bun using stable decision criteria such as compatibility needs, reproducibility and team workflow, giving a conditional choice without unsupported current feature or performance claims.',
      expectSearchOffer:
        'State the freshness limitation of changeable context and offer to verify current facts before relying on them.',
    },
    followUps: [
      {
        prompt:
          'Yes, please verify the latest non-prerelease Bun release number on its official release page; give the number and a supporting source.',
      },
    ],
    criteria: evidenceLookup,
    expectation: {
      expectEvidenceCoverage:
        'Verify the requested latest non-prerelease Bun release number against its official release page and cite it; do not merely repeat the earlier recommendation.',
    },
  },
]

/** Build the search-necessity matrix, optionally including the noisier verification scenarios. */
export const getNecessityScenarios = (
  modelNames?: string[],
  engineNames?: string[],
  includeOptional = process.env.EVAL_NECESSITY_OPTIONAL === '1',
): EvalScenario[] =>
  evalModels
    .filter(
      ({ name, engineName }) =>
        (!modelNames || modelNames.includes(name)) && (!engineNames || engineNames.includes(engineName)),
    )
    .flatMap((model) =>
      prompts
        .filter(({ category }) => includeOptional || category !== 'search_wont_help')
        .map((definition) => ({
          id: `${model.name}/${model.engineName}/chat/${definition.id}`,
          modelName: model.name,
          engineName: model.engineName,
          modeName: 'chat',
          prompt: definition.prompt,
          followUps: definition.followUps,
          expectation: definition.expectation,
          promptCriteria: definition.promptCriteria,
          promptExpectation: definition.promptExpectation,
          criteria: definition.criteria,
          category: definition.category,
          reviewBy,
          isNegativeControl: definition.isNegativeControl,
        })),
    )
