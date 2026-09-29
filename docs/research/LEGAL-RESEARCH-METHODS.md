# Legal research methods for the VisLex case agent

Reference compiled 2026-09-29. This is the long-form background for
`src-tauri/resources/research/research-playbook.md`, which is the compact version
injected into the case agent's system prompt. The playbook is operational; this
document explains the reasons and records the sources.

Scope: an agent that drives the user's own signed-in Westlaw session inside the VisLex
research browser, captures what it relies on as case evidence, and writes research
memos. The current test matter is an Ohio municipal theft prosecution (Findlay Municipal
Court, Hancock County; appeals to the Ohio Third District Court of Appeals; charge under
Findlay Codified Ordinance 545.05, which tracks R.C. 2913.02). The methods are written to
apply to any charge and any U.S. jurisdiction. Ohio is the worked example.

Nothing in this document is legal advice, and no document or test can certify that a
research result is accurate or complete. Authorities named below are research leads
checked against the cited sources on the date above. Before relying on any of them, open
the authority in Westlaw, read it, KeyCite it, and capture the passage.

---

## 0. Sources relied on (retrieved 2026-09-29)

Thomson Reuters (Westlaw)
- [W1] Thomson Reuters, *Quick Reference Guide: Searching with Boolean Terms and Connectors* (Westlaw), L-362608/5-16. https://static.legalsolutions.thomsonreuters.com/product_files/westlaw/wlawdoc/web/wlnterms.pdf
- [W2] Thomson Reuters Help, *About KeyCite Status Flags*. https://www.thomsonreuters.com/en-us/help/drafting-assistant/westcheck/keycite-status-flags
- [W3] Thomson Reuters Help (Westlaw Advantage), *KeyCite Overruling Risk*. https://www.thomsonreuters.com/en-us/help/westlaw-advantage/tools/keycite-overruling-risk
- [W4] Thomson Reuters, *Quick Reference Guide: How to identify implicitly invalidated case law (KeyCite Overruling Risk)*. https://legal.thomsonreuters.com/content/dam/ewp-m/documents/legal/en/pdf/quick-reference-guides/westlaw-edge-keycite-overruling-risk_qrg.pdf
- [W5] Thomson Reuters, *Quick Reference Guide: How to use the Key Number System*. https://legal.thomsonreuters.com/content/dam/ewp-m/documents/legal/en/pdf/quick-reference-guides/s076047-wle-searching-with-topic-and-key-number.pdf
- [W6] Thomson Reuters Help, *Understanding Precision Research*. https://www.thomsonreuters.com/content/helpandsupp/en-us/help/westlaw-precision/searching/understanding-precision-research.html
- [W7] Thomson Reuters blog, *Meet Westlaw Advantage*. https://legal.thomsonreuters.com/blog/meet-westlaw-advantage-the-next-generation-ai-legal-research-solution/
- [W8] Thomson Reuters Product Training, *How to view cases frequently cited together* (KeyCite Cited With). https://training.thomsonreuters.com/media/How+to+view+cases+frequently+cited+together/1_f4jq8nk4
- [W9] Thomson Reuters, *Searching with Terms and Connectors* (Westlaw, 2009 guide, fields, plurals, common terms), hosted by Lewis & Clark Law School. https://law.lclark.edu/live/files/9394-westlaw-terms-and-connectors-searching

Law-school and law-library research guides
- [L1] Washington University in St. Louis Law Library, *KeyCite on Westlaw Precision*. https://libguides.wustl.edu/c.php?g=1034994&p=7502617
- [L2] Stanford Law School, *Is the Case Still Good Law?* https://guides.law.stanford.edu/cases/goodlaw
- [L3] Georgetown Law Library, *Finding Cases: Digests, Headnotes, and Key Numbers*. https://guides.ll.georgetown.edu/cases/headnotes
- [L4] Georgetown Law Library, *Secondary Sources Research Guide*. https://guides.ll.georgetown.edu/secondary
- [L5] Georgetown Law Library, *Case Law Research Guide*. https://guides.ll.georgetown.edu/cases
- [L6] Georgetown Law Writing Center, *Which Court Is Binding?* (Painter & Mayer, rev. 2017). https://www.law.georgetown.edu/wp-content/uploads/2018/07/Which-Court-is-Binding-HandoutFinal.pdf
- [L7] Penn State Law Library blog, *Parallel Search on Westlaw* (2025-03-26). https://sites.psu.edu/keepingitbrief/2025/03/26/parallel-search-on-westlaw/
- [L8] Penn State Law Library blog, *From Westlaw Precision to Westlaw Advantage* (2026-01-14). https://sites.psu.edu/keepingitbrief/2026/01/14/from-westlaw-precision-to-westlaw-advantage/
- [L9] Boston College Law Library, *Basic Legal Research Process: When to Stop*. https://lawguides.bc.edu/c.php?g=350931&p=2367344
- [L10] University of San Francisco School of Law, *When to Stop Your Research*. https://legalresearch.usfca.edu/ResearchStrategies/StrategyWhenToStop
- [L11] Hamilton County (Ohio) Law Library, *Ohio Primary Law: Courts & Cases*. https://libguides.hamilton-co.org/c.php?g=392905&p=2668920
- [L12] Hamilton County Law Library, *Westlaw flag help* (KeyCite quick reference). https://lawlibrary.hamiltoncountyohio.gov/wp-content/uploads/2021/07/Westlaw-flag-help.pdf
- [L13] University of Cincinnati Law Library, *Jury Instructions* (OJI on Westlaw). https://guides.libraries.uc.edu/c.php?g=222612&p=1473128
- [L14] University of South Carolina Law Library, *Checklist: Researching a State Statute* / *Updating statutes with KeyCite*. https://guides.law.sc.edu/LRAWFall/ChecklistResearchingProblemStateStatute
- [L15] William S. Richardson School of Law (Hawaii), *Westlaw Advanced Search Commands* (date field syntax). https://law-hawaii.libguides.com/c.php?g=1223564&p=8952453
- [L16] Cornell LII, *Introduction to Basic Legal Citation* (P. Martin). https://www.law.cornell.edu/citation/

Ohio primary law and official materials
- [O1] Supreme Court of Ohio, *Supreme Court Rules for the Reporting of Opinions* (eff. July 1, 2012). https://www.supremecourt.ohio.gov/docs/LegalResources/rules/reporting/Report.pdf
- [O2] Supreme Court of Ohio, *Writing Manual* (3d ed., eff. June 17, 2024). https://www.supremecourt.ohio.gov/docs/ROD/manual3e.pdf
- [O3] Ohio Constitution, Article IV, Section 3 (courts of appeals; (B)(3) weight reversal; (B)(4) conflict certification). https://codes.ohio.gov/ohio-constitution/section-4.3
- [O4] Ohio Constitution, Article XVIII, Section 3 (municipal home rule). https://codes.ohio.gov/ohio-constitution/section-18.3
- [O5] Ohio Legislative Service Commission, *Municipal Home Rule* (Members Brief). https://www.lsc.ohio.gov/assets/organizations/legislative-service-commission/files/municipal-home-rule.pdf
- [O6] Ohio Third District Court of Appeals, *About Us* (17 counties incl. Hancock). https://www.third.courts.state.oh.us/about-us/
- [O7] R.C. 2901.21 (culpability requirements; default recklessness). https://codes.ohio.gov/ohio-revised-code/section-2901.21
- [O8] R.C. 2901.22 (culpable mental states). https://codes.ohio.gov/ohio-revised-code/section-2901.22
- [O9] R.C. 2913.02 (theft; eff. Apr. 9, 2025 version). https://codes.ohio.gov/ohio-revised-code/section-2913.02
- [O10] R.C. 2945.71 (time for trial). https://codes.ohio.gov/ohio-revised-code/section-2945.71
- [O11] R.C. 2929.24 (misdemeanor jail terms). https://codes.ohio.gov/ohio-revised-code/section-2929.24
- [O12] R.C. 2929.28 (misdemeanor financial sanctions). https://codes.ohio.gov/ohio-revised-code/section-2929.28
- [O13] R.C. 2935.041 (merchant detention). https://codes.ohio.gov/ohio-revised-code/section-2935.041
- [O14] R.C. 1901.30 (appeals from municipal court). https://codes.ohio.gov/ohio-revised-code/section-1901.30
- [O15] Ohio Rules of Criminal Procedure (Crim.R. 12, 12.1, 12.2, 16, 29, 30). https://www.supremecourt.ohio.gov/docs/legalResources/rules/criminal/criminalprocedure.pdf
- [O16] Ohio Rules of Professional Conduct (Prof.Cond.R. 3.3). https://www.supremecourt.ohio.gov/docs/LegalResources/Rules/ProfConduct/profConductRules.pdf
- [O17] Findlay Codified Ordinances 545.05, *Misdemeanor Theft* (American Legal Publishing). https://codelibrary.amlegal.com/codes/findlay/latest/findlay_oh/0-0-0-12962
- [O18] State v. Johnson, 2025-Ohio-2103 (3d Dist.) (example of Third District sufficiency standard and citation form). https://www.supremecourt.ohio.gov/rod/docs/pdf/3/2025/2025-Ohio-2103.pdf
- [O19] Collateral Consequences Resource Center, *Ohio* resources; Ohio Justice & Policy Center, *Collateral Sanctions* (CIVICC). https://ccresourcecenter.org/resources-2/state-specific-resources/ohio-2/ and https://ohiojpc.org/collateralsanctions/
- [O20] National Inventory of Collateral Consequences of Conviction, *Civil Impacts of Criminal Convictions under Ohio Law*. https://niccc.nationalreentryresourcecenter.org/news-resources/civil-impacts-criminal-convictions-under-ohio-law

Where a statement below depends on one of these sources the bracketed tag is given.
Statements without a tag are standard research practice.

---

## 1. Research process

1. **Frame the question from the record.** Read the charging instrument, the ordinance or
   statute cited, police reports, statements and any motions already filed. Write down
   the court, the jurisdiction, the offence date, and the procedural posture (pretrial,
   trial, sentencing, appeal). The offence date fixes which version of a statute applies;
   the forum fixes which authorities bind.
2. **Identify the issues.** For each charge: its elements, the culpable mental state, the
   penalty class, lesser-included offences, and each fact that proves or disproves an
   element. Then list procedural and constitutional issues raised by the facts (stop,
   detention, search, statements, identification, speedy trial, discovery, jury
   instructions, sentencing, collateral consequences).
3. **Orient with secondary sources.** Treatises, practice guides, ALR annotations, legal
   encyclopedias and pattern jury instructions explain the area and cite the leading
   primary law. Georgetown's guides advise starting there rather than with raw case
   searches [L4]. Secondary sources are never the rule itself; they are maps.
4. **Go to the enacted text.** Read the current statute or ordinance, confirm the version
   in force on the offence date, and read its annotations (Notes of Decisions) and
   KeyCite. For a statutory offence, the annotations and citing references of the section
   are usually the fastest route to controlling cases [L5].
5. **Find controlling cases.** Start in the highest binding court, then the home
   intermediate appellate court, then persuasive courts. Use terms and connectors built
   from elements and facts, then expand from good cases via headnotes, Key Numbers,
   citing references and Cited With.
6. **Read and verify.** Read the opinion itself (not headnotes, synopsis or AI summary).
   Identify the holding versus dicta, the posture and the standard of review. KeyCite it:
   flag, direct history, negative treatment, and relevant citing references.
7. **Capture.** Save the passage relied on with an exact quote and pin cite.
8. **Look for adverse authority** deliberately with the same care as for favourable
   authority.
9. **Update and stop.** Stop when new searches in different tools and terms return the
   same authorities and nothing new changes the answer, when the governing rule and
   leading authorities are known and verified [L9][L10]. Record the stopping point and
   remaining gaps.

---

## 2. Westlaw search technique

### 2.1 How Westlaw decides the search mode [W1]

A query in the main search box is processed as **Terms & Connectors** (Boolean) if it
contains a grammatical connector (`/s /p +s +p`), a numerical connector (`/n +n`), the
BUT NOT connector (`%`), a root expander (`!`), the universal character (`*`), a phrase
in quotation marks, or a field restriction. A query that contains only `&` and spaces
(OR) is treated as a **plain-language** (descriptive terms) search. To force Boolean
processing of an `&`/OR-only query, prefix it with `adv:` (or `advanced:`) or use the
Advanced Search page.

### 2.2 Terms and connectors [W1][W9]

| Syntax | Meaning | Example |
|---|---|---|
| `&` | both terms anywhere in the document | `narcotics & warrant` |
| space (or `OR`) | either term | `attorney lawyer counsel` |
| `/s` | same sentence | `design /s defect` |
| `+s` | first term precedes second, same sentence | `attorney +s fee` |
| `/p` | same paragraph | `hearsay /p utterance` |
| `+p` | first precedes second, same paragraph | `exception +p non-liability` |
| `/n` | within n terms (n = 1 to 255) | `personal /3 jurisdiction` |
| `+n` | first precedes second by n terms or fewer | `capital +3 gain` |
| `%` | BUT NOT: excludes everything after it; put at the end | `tax taxation /s income % investment` |
| `" "` | exact phrase | `"res ipsa loquitur"` |
| `!` | root expander (any ending) | `object!` → object, objected, objection |
| `*` | universal character (one character per `*`) | `withdr*w` → withdraw, withdrew |
| `#` | exactly as typed; turns off plurals and equivalents | `#damage` excludes damages |
| `( )` | groups; processed first | `frisk! (search! /3 seiz!)` |

**Order of processing** [W1]: `" "`, space (OR), `+n`, `/n`, `+s`, `/s`, `+p`, `/p`,
`&`, `%`. Because OR binds tighter than proximity connectors,
`frisk! search! /3 seiz!` means (frisk! OR search!) /3 seiz!. Use parentheses to
change the grouping.

**Plurals and equivalents** [W9]: a singular term retrieves its plural automatically; a
plural retrieves only the plural. Westlaw also retrieves common equivalents (for example
abbreviations). Use `#` to turn this off.

**Common terms in phrases** [W9]: a common word embedded in a quoted phrase acts only as a
placeholder, so `"judgment with prejudice"` also matches "judgment without prejudice".
Check phrase results accordingly.

**Citation searches** [W1]: use `+n` with volume and page or title and section, for
example `(15 +5 1311) (42 +5 1985)`; for Ohio statutes, `2913.02` alone or
`"2913.02"` works in the main box, and `2913.02 /p "petty theft" "misdemeanor theft"`
narrows to passages.

### 2.3 Field restrictions [W1][W9]

Fields vary by content type; the Advanced Search page for each content type lists the
available fields. Syntax: field abbreviation immediately followed by terms in
parentheses; combine fields with a comma, e.g. `sy,di(retaliat! /p whistle-blow!)`.
Common case-law fields:

- `TI( )` title (party names): `TI(thompkins)`
- `SY( )` synopsis (West editorial summary)
- `DI( )` digest (headnotes); `SY,DI( )` searches both
- `CO( )` court; `JU( )` judge; `AT( )` attorney
- `DA( )` decision date: `DA(2004)`, `DA(9/2000)`, `DA(aft 2002)`, `DA(bef 6/1999)`,
  combined with `&`: `DA(aft 2002) & DA(bef 2020)` [L15]

Searching `SY,DI` is a useful way to find cases on a point, but the synopsis and
headnotes are West editorial text and must never be quoted as the court's words.

### 2.4 Jurisdiction, content type, filters, sort

- **Jurisdiction selector** (beside the search box): choose before searching, e.g. Ohio
  state + Ohio federal, or a single state; the choice filters every content type.
- **Content types** on the results page: Cases, Statutes & Court Rules, Regulations,
  Secondary Sources, Practical Law, Briefs, Trial Court Documents, Jury Instructions
  (where the subscription includes them).
- **Narrow** (left column): jurisdiction and court, date, reported/unreported status,
  judge, attorney, Key Number, practice area; Precision attributes where available (legal
  issue and outcome, fact pattern, motion type and outcome, cause of action) [W6].
- **Search within results**: add terms with any connectors, including `&` and OR [W1].
- **Sort**: relevance by default; date sort is useful for recency checks and when the
  newest home-district statement of a standard is wanted [W1].

### 2.5 Key Numbers, headnotes and digests [W5][L3]

West editors summarise each point of law in a published opinion as a headnote and assign
it a West Topic and Key Number (a unique point of law within about 450 topics). From a
good case:

- Click the Key Number on the relevant headnote to see all cases classified to it; then
  narrow by jurisdiction and date. This finds cases even when they use different words.
- **"Cases that cite this headnote"** lists later cases that cite the case for that
  specific point. It is often the fastest route from one good case to its progeny on the
  exact issue.
- Browse the **Key Numbers** index directly (Browse > Key Numbers) when you know the
  topic but not a case.

### 2.6 KeyCite citing references, Cited With, Parallel Search, Deep Research

- **Citing References** tab: every document citing the authority. Filter by
  jurisdiction, content type, date, **depth of treatment**, **headnote** and treatment
  (e.g. "distinguished", "followed").
- **Cited With** (Precision/Advantage) [W8][L1]: cases that are frequently cited together
  with the base case, even where neither cites the other and they share no Key Number; a
  co-citing panel lists cases citing both.
- **Parallel Search** [L7][W6]: a concept search that matches sentences with similar
  meaning. Write a full sentence of about 5 to 30 words combining the legal rule and key
  facts; limited to 25 results; filter by jurisdiction; wording changes can alter
  results. Useful to find a rule statement in the home district fast; always read and
  KeyCite the hits.
- **Westlaw Advantage / Deep Research / CoCounsel** [W7][L8]: Thomson Reuters' 2025
  release adds agentic Deep Research and AI-generated answers. These outputs are leads
  only. The agent must never cite an AI answer, summary or report; it must open each
  authority named, read it, KeyCite it and capture the passage.

### 2.7 Reading the document

A Westlaw case page contains, in order: the KeyCite flag, the caption and citations,
West synopsis, headnotes with Key Numbers, attorneys and judges, and the **opinion** (the
court's text). Only the opinion text (including majority, concurrence and dissent, each
labelled) is the court's words. For Ohio Supreme Court opinions, the **official syllabus**
is part of the law of the case [O1 Rep.Op.R. 2.2] and is distinct from West's synopsis.

**Pin cites**: star paging (`*123`) marks the start of page 123 in the named reporter;
Ohio opinions since 2002 also carry numbered paragraphs (`¶ 12`), which are the preferred
Ohio pinpoint [O1 Rep.Op.R. 2.5, 3.5(B)][O2].

---

## 3. KeyCite

### 3.1 Status flags for cases [W2][W3][L1][L12]

| Flag | Meaning |
|---|---|
| Red flag | No longer good law for at least one point of law it contains (e.g. reversed, overruled). |
| Red-striped flag (Precision/Advantage) | Overruled in part; KeyCite links to the language discussing the overruled point. Other points may remain good law. |
| Yellow flag | Some negative history or treatment but not reversed or overruled (e.g. distinguished, criticised, limited). |
| Blue-striped flag | Appealed to a U.S. Court of Appeals or the U.S. Supreme Court (excluding appeals from agencies). |
| Orange circle/warning icon (KeyCite Overruling Risk) | A point of law may be implicitly undermined because the case relies on a decision that has been overruled or is otherwise invalid; orange brackets mark the affected paragraphs. |
| Blue H | Has some direct history, none known negative. |
| Green C | Has citing references but no direct history or negative citing references. |

A flag attaches to a document, not a proposition. A red or yellow flag may concern a
point unrelated to the one relied on, and no flag does not prove a point is still good
law. Always open the tabs and read what the negative treatment concerns.

The blue-striped flag covers federal appeals; a pending or declined appeal to the Supreme
Court of Ohio appears in **History**, not as a stripe. Under Rep.Op.R. 4.1, the Supreme
Court's refusal to accept a discretionary appeal is not a statement on the merits [O1].

### 3.2 Status flags for statutes and regulations [W2][L14]

- **Red**: amended by a recent session law, repealed, superseded, or held
  unconstitutional or preempted in whole or in part.
- **Yellow**: renumbered or transferred, limited on constitutional or preemption grounds,
  or affected by pending (proposed) legislation.
- **Green C**: has citing references.

Review the statute's History (credits, amendments) whether or not a flag appears [L14].

### 3.3 Tabs

- **Negative Treatment**: negative direct history and negative citing references, each
  with depth and headnote. Read every entry that touches the point relied on.
- **History**: direct history (the same case at other levels: appeals, remands, related
  decisions) and, for statutes, legislative history and credits.
- **Citing References**: everything that cites the document, filterable (2.6).
- **Notes of Decisions** (statutes): annotated case summaries by topic.
- **Cited With** (Precision/Advantage).

### 3.4 Depth of treatment [L2]

Shown as green bars (formerly stars): 4 = examined (extended discussion, usually more
than a printed page), 3 = discussed (substantial discussion), 2 = cited (some
discussion), 1 = mentioned (brief reference, often in a string cite). Filter citing
references to depth 3 to 4 and the relevant headnote to find the cases that actually
analyse the point.

---

## 4. Binding versus persuasive authority

### 4.1 General rules [L6]

- Ask two questions: is the issue governed by state or federal law, and which court is
  deciding it?
- Higher courts bind lower courts within the same system and territory. A court of last
  resort binds every lower court in its system.
- The U.S. Supreme Court binds all courts, state and federal, on federal law.
- A federal circuit binds district courts within the circuit; it is persuasive elsewhere
  and does not bind state courts. District court decisions bind no other court.
- On questions of state law, the state's highest court binds that state's courts and
  federal courts applying that state's law. Other states' decisions are persuasive.
- Some states have regional intermediate appellate districts whose decisions bind only
  trial courts within the district [L6 n.5]. Ohio is one.
- Holdings bind; dicta, concurrences and dissents do not. Plurality opinions need care.

### 4.2 Ohio

- **Supreme Court of Ohio** binds all Ohio courts. The law stated in its opinion is in the
  text, including the syllabus (if any) and footnotes (Rep.Op.R. 2.2); introductory
  material other than the syllabus is only a research aid (Rep.Op.R. 2.4); per curiam
  and signed majority opinions have equal authority (Rep.Op.R. 2.3) [O1].
- **Courts of appeals**: twelve districts. A district's decisions bind the trial courts
  in that district; other districts' decisions are persuasive. When a court of appeals
  finds its judgment conflicts with another district's judgment "upon the same
  question", it must certify the record to the Supreme Court (Ohio Const. art. IV,
  §3(B)(4)) [O3]. A conflict between districts is itself worth reporting.
- **Third District** covers 17 counties including Hancock (Findlay Municipal Court) [O6].
  Appeals from municipal courts go to the court of appeals under the Appellate Rules
  (R.C. 1901.30) [O14]. For the test case, Third District decisions bind the Findlay
  Municipal Court; on appeal the Third District panel will ordinarily follow its own
  precedent, but it is not a higher court over itself, so present them as its own
  controlling precedent rather than as authority that compels it.
- **Unpublished/reporting status**: all court of appeals opinions issued after May 1,
  2002 "may be cited as legal authority and weighted as deemed appropriate by the
  courts" regardless of publication (Rep.Op.R. 3.4) [O1][L11]. Before that date,
  unreported opinions were treated as persuasive (controlling only between the parties)
  while officially reported ones controlled in the district [L11]; label a pre-May 2002
  unreported opinion as persuasive only.
- **Ohio Official Reports**: the Supreme Court website is the official report for court
  of appeals and Court of Claims opinions since July 1, 2012 (Rep.Op.R. 3.2) [O1].
- **Weight on appeal**: a jury verdict cannot be reversed on the weight of the evidence
  except by all three judges (Ohio Const. art. IV, §3(B)(3)) [O3].
- **Federal courts in Ohio**: Sixth Circuit and N.D./S.D. Ohio decisions do not bind
  Ohio state courts; only the U.S. Supreme Court does, on federal questions [L6].

### 4.3 Weighing within a tier

Prefer: the most recent statement from the highest binding court; published over
unpublished where the jurisdiction draws that line; unanimous holdings; cases with
similar posture and standard of review; cases with deep, favourable citing treatment.
Note any split, any certified conflict, and any case pending in a higher court.

---

## 5. Statutes, ordinances, jury instructions

- **Enacted text first.** Legal research on an offence starts with the words of the
  statute or ordinance actually charged.
- **Version in force.** Check the effective date and amendment history and apply the
  version in force on the offence date (for example, R.C. 2913.02 was amended effective
  Apr. 9, 2025, and division (B)(2) now uses "misdemeanor theft" where earlier versions
  said "petty theft") [O9]. Note the change so older cases using the older label are read
  correctly.
- **Annotations.** Use Notes of Decisions (Baldwin's Ohio Revised Code Annotated on
  Westlaw; Page's on Lexis) to find interpreting cases by topic; they are editorial
  summaries, so open each case.
- **Municipal ordinances.** Ohio municipalities may adopt police regulations not in
  conflict with general laws (Ohio Const. art. XVIII, §3) [O4]. An ordinance conflicts
  with a general law if it "permits or licenses that which the statute forbids and
  prohibits, and vice versa" (Struthers v. Sokol, 108 Ohio St. 263 (1923), para. two of
  syllabus); an ordinance that changes a state misdemeanor to a felony or vice versa
  conflicts [O5]. Where an ordinance mirrors a state statute (Findlay C.O. 545.05 tracks
  R.C. 2913.02 and classifies the offence as a first-degree misdemeanor [O17]), case law
  interpreting the state statute is the principal interpretive authority for the
  ordinance; note any textual difference. Westlaw's municipal-code coverage is limited;
  read the ordinance on the publisher's site (e.g. American Legal Publishing) and record
  that the online code is unofficial and may lag enacted legislation [O17].
- **Pattern jury instructions.** Ohio Jury Instructions (OJI-CR) are on Westlaw and give
  the elements, definitions and committee notes with cited authority [L13]. They are
  persuasive, not binding, and must be checked against current statutes and cases.
- **Court rules** (Crim.R., Evid.R., App.R., local rules) are law for procedure; check
  amendment dates [O15].

---

## 6. Criminal-defence issue checklist (any charge)

Work the checklist against the actual record. Each item is a prompt to research, not a
conclusion.

1. **Charge and elements.** Exact charging language; statute/ordinance version on the
   offence date; each element; the degree/penalty class and any value or prior-conviction
   enhancers (who must prove them and how).
2. **Culpable mental state.** Ohio: purposely, knowingly, recklessly, negligently
   (R.C. 2901.22) [O8]; if a section specifies no mental state and does not plainly
   indicate strict liability, recklessness applies (R.C. 2901.21(C)) [O7]. For theft,
   "with purpose to deprive" plus "knowingly" obtaining or exerting control
   (R.C. 2913.02(A)) [O9].
3. **Lesser-included and alternative offences**; merger/allied offences.
4. **Defences.** Affirmative defences and their notice requirements (e.g. Crim.R. 12.1
   alibi and 12.2 self-defence notices: 14 days before trial in misdemeanours) [O15];
   claim of right, consent, mistake of fact negating mental state, identity.
5. **Pretrial motions and timing.** Crim.R. 12(C) lists motions that must be raised before
   trial, including suppression of evidence, statements and identification; Crim.R.
   12(D): within 35 days after arraignment or 7 days before trial, whichever is earlier,
   unless extended [O15].
6. **Fourth Amendment / Ohio Const. art. I, §14.** Stop, detention, arrest, search,
   probable cause, consent, warrant exceptions. For retail theft, merchant detention
   authority requires probable cause and reasonable manner and duration
   (R.C. 2935.041(A)) [O13]; private-actor versus state-action questions.
7. **Statements.** Miranda custody and interrogation, voluntariness, invocation,
   private security questioning versus police agency.
8. **Identification.** Suggestive procedures, video authentication and chain of custody.
9. **Confrontation.** Testimonial hearsay (e.g. absent loss-prevention witness, reports).
10. **Speedy trial.** R.C. 2945.71: minor misdemeanour 30 days; M3/M4 45 days; M1/M2 90
    days after arrest or service of summons; felony 270 days; each day jailed in lieu of
    bail on the pending charge counts as three [O10]. Check tolling (R.C. 2945.72),
    waivers and the constitutional right separately.
11. **Discovery.** Crim.R. 16(B) on written demand: defendant statements, criminal
    records, documents and tangible objects, test results, favourable evidence, police
    reports, witness statements; reciprocal and continuing [O15]; Brady.
12. **Trial.** Crim.R. 29 acquittal if the evidence is insufficient; the court may not
    reserve ruling on a motion made at the close of the state's case; renewal within 14
    days after discharge [O15]. Sufficiency (burden of production; "whether, after viewing
    the evidence in a light most favorable to the prosecution, any rational trier of fact
    could have found the essential elements ... proven beyond a reasonable doubt": State
    v. Jenks, 61 Ohio St.3d 259 (1991), para. two of syllabus, as applied in [O18]) is
    distinct from manifest weight (burden of persuasion; State v. Thompkins, 78 Ohio St.3d
    380 (1997)). Open and KeyCite both before use.
13. **Jury instructions.** Crim.R. 30 written requests and objection before the jury
    retires; OJI-CR; lesser-included instructions [O15][L13].
14. **Sentencing.** Ohio misdemeanour sentencing R.C. 2929.21-.28: maximum jail M1 180
    days, M2 90, M3 60, M4 30 (R.C. 2929.24) [O11]; maximum fines M1 $1,000, M2 $750, M3
    $500, M4 $250, minor misdemeanour $150 (R.C. 2929.28) [O12]; purposes and factors
    (R.C. 2929.21-.22); community control; restitution; jail-time credit.
15. **Collateral consequences.** Employment, licensing, immigration, housing, firearms,
    record sealing; Ohio CIVICC and NICCC inventories [O19][O20].
16. **Appeal preservation.** Objections, proffers, renewal of motions; standard of review
    for each issue.

---

## 7. Citation form basics

- Case citation elements: case name; volume, reporter, first page; pinpoint; court and
  year parenthetical (omit the court when the reporter makes it unambiguous);
  subsequent history [L16].
- Ohio (Writing Manual, 3d ed. 2024) [O2]: webcite with year, paragraph pinpoint, and
  district in parentheses for courts of appeals, e.g. `State v. Johnson, 2025-Ohio-2103,
  ¶ 4 (3d Dist.)`; Supreme Court cases add the Ohio St.3d cite where available. Earlier
  Ohio citations with case numbers and county remain common in older opinions.
- Unreported opinions without a public-domain cite: cite the Westlaw number
  (`2001 WL 123456`) with court and exact date.
- Statutes: `R.C. 2913.02(A)(1)`; ordinances: `Findlay Codified Ordinances 545.05(A)(1)`.
- Always cite the version and give the effective date when versions differ.

---

## 8. Common pitfalls

- **Headnotes, synopses, Key Number text and Notes of Decisions are not law.** They are
  West editorial content; cite and quote only the opinion (and, in Ohio, the official
  syllabus) [L3][O1].
- **AI answers are not authority.** Westlaw AI, CoCounsel, Deep Research and any other
  summariser may misstate holdings; verify in the text [W7].
- **Unverified existence.** Never cite a case that was not opened in this session.
  Citation formats that look right can be fabricated.
- **Overruled or undermined cases.** Check red, red-striped, yellow flags and Overruling
  Risk; read the negative treatment; a flagged case may still be good for another point.
- **Wrong version of a statute** or a renumbered section.
- **Weight labels.** Citing a pre-May 2002 unreported Ohio appellate opinion, another
  district's case, or a federal circuit case as binding.
- **Pin cites.** Pin to the page or paragraph where the quoted language appears, not
  to the first page; star pages in Westlaw mark where a page begins.
- **Dicta and posture.** A statement outside the holding, or a result driven by a
  deferential standard of review (plain error, abuse of discretion), carries less weight.
- **Adverse authority.** Ohio Prof.Cond.R. 3.3(a)(2) forbids knowingly failing to disclose
  "legal authority in the controlling jurisdiction known to the lawyer to be directly
  adverse" and not disclosed by opposing counsel [O16]. The agent reports adverse
  authority to the user; the lawyer decides how to present it.
- **Stopping too early or too late.** Stop when searches converge, record the
  stopping point and gaps [L9][L10].

---

## 9. How the VisLex tools map to this method

- `research_westlaw_search(query, jurisdiction, content_type)`: runs a Westlaw search and
  returns ranked rows (title, court, date, citations, snippet, url). Preferred for
  Westlaw searching.
- `research_westlaw_document(url)`: returns the header (title, court, date, all
  citations), KeyCite (flag, negative treatment count, history count, citing references
  count) and opinion text lines. Preferred for reading and KeyCite status.
- `research_navigate`, `research_snapshot`, `research_act`, `research_read_page`,
  `research_status`: the generic browser tools; used when a Westlaw page differs from
  what the fast tools expect (Negative Treatment, History, Citing References filters,
  headnote links, Cited With, ordinance sites, government sites).
- `research_capture`: saves the document and records the exact quoted lines for one
  proposition, returning a citable evidence locator. Required before citing.
- `write_record` (kind `report`): saves the research memo in the case.
