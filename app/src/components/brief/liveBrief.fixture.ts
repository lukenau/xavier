// A synthetic brief for the brief tests: 44 items across four buckets, 110
// deferred entries, one stale source, one carried run. Every title, sender and
// sentence in it is invented. What it is built to exercise is length and count,
// since that is what the layout has to survive (33-68 char titles, evidence up
// to 196 chars, 44 rows in one scroll).
//
// `token` and `detail` are filled at plausible lengths, as brief_triage's
// _emit() writes them.
import type { Brief } from './briefModel';

export const LIVE_BRIEF: Brief = {
  "date": "2026-09-16",
  "generated_at": "2026-09-16T11:22:21.417051+00:00",
  "buckets": {
    "now": [
      {
        "item_id": "b7868d667bb9",
        "id": "calendar:b7868d66",
        "title": "November hotel nocturne echo tango ingot....",
        "why": "Quarry lima beacon delta...",
        "evidence": [
          "Oscar bravo girder xray papa oscar victor charlie trellis trellis foxtrot nocturne lantern..."
        ],
        "gate": "O6",
        "source": "Calendar",
        "origin": "calendar",
        "kind": "event",
        "split": "work",
        "when": "2026-09-16T09:00:00-04:00",
        "age_days": 0,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Jetty romeo ingot lantern romeo india anchor dossier keel yankee quarry lima oscar beacon whiskey jetty kilo obelisk fathom quebec oscar ingot rampart mike uniform victor india anchor quebec victor jetty yankee jetty",
        "token": "5b511c1d6afaaa4cf24dafb8"
      },
      {
        "item_id": "88152549b6e3",
        "id": "oura:88152549",
        "title": "Hotel harbor kilo hotel golf nocturne lima....",
        "why": "Victor india november.",
        "evidence": [
          "Zulu jetty yankee charlie nocturne sextant sierra victor cipher quebec ingot echo....."
        ],
        "gate": "O1",
        "source": "Oura",
        "origin": "oura",
        "kind": "daily_summary",
        "split": "personal",
        "when": "2026-09-16T11:00:53.722357+00:00",
        "age_days": 0,
        "carried_from": "",
        "carry_days": null,
        "url": "/oura/",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Cipher quarry mortise lima hotel november ingot xray papa ingot echo nocturne sextant foxtrot anchor quebec oscar ingot kilo alpha mortise sextant zulu quarry lima beacon juliet harbor ember keel ember xray cipher delta.....",
        "token": "4bd94ad49b1eb76617d96e6e"
      }
    ],
    "today": [
      {
        "item_id": "23f0536bc7a1",
        "id": "calendar:23f0536b",
        "title": "Xray whiskey cipher dossier xray quarry.",
        "why": "Kilo uniform victor cipher delta tango india..",
        "evidence": [
          "Ingot rampart mortise yankee whiskey cipher xray quarry fathom delta golf anchor whiskey plinth mortise fathom ember delta tango..."
        ],
        "gate": "O6",
        "source": "Calendar",
        "origin": "calendar",
        "kind": "event",
        "split": "work",
        "when": "2026-09-16T10:00:00-04:00",
        "age_days": 0,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Keel ember keel rampart sextant foxtrot golf alpha tango ingot rampart mortise lantern echo anchor whiskey plinth sierra plinth mortise sextant sierra papa victor jetty rampart mortise lima uniform...",
        "token": "3d8cd80b48b0eeab9ba7b3f8"
      },
      {
        "item_id": "0c627bfeca25",
        "id": "imessage:0c627bfe",
        "title": "Charlie trellis mortise lantern lantern",
        "why": "Fathom rampart sierra cipher.",
        "evidence": [
          "Echo tango papa oscar obelisk lantern yankee jetty romeo ingot...."
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-13T16:23:09.799Z",
        "age_days": 3,
        "carried_from": "2026-09-15",
        "carry_days": 2,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Beacon quarry mortise lantern echo november oscar beacon juliet obelisk lantern lima beacon quebec oscar victor india harbor keel lantern sextant mike obelisk yankee juliet alpha zulu quarry......",
        "token": "2c3d8bf1bd773684297f758a"
      },
      {
        "item_id": "b4fbd636fe0f",
        "id": "imessage:b4fbd636",
        "title": "Plinth sextant mortise sextant foxtrot alpha",
        "why": "Charlie golf tango india.....",
        "evidence": [
          "Delta trellis mike beacon quarry mortise fathom......"
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-12T05:39:25.336Z",
        "age_days": 4,
        "carried_from": "2026-09-15",
        "carry_days": 4,
        "url": "",
        "jump_url": "",
        "related": [
          "6b8e1995d99f"
        ],
        "conflict": false,
        "detail": "Foxtrot tango india alpha trellis trellis trellis mike uniform papa india harbor rampart sextant mortise sextant sierra plinth sextant foxtrot nocturne fathom rampart foxtrot girder xray quarry sierra plinth lima....",
        "token": "8904d5d768029abfbf9f2f2a"
      },
      {
        "item_id": "6b8e1995d99f",
        "id": "email:6b8e1995",
        "title": "Alpha mortise fathom ember delta tango....",
        "why": "Quarry mortise..",
        "evidence": [
          "Jetty kilo harbor xray cipher juliet november beacon quebec oscar bravo tango charlie girder kilo obelisk sierra papa."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-15T16:09:22Z",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [
          "b4fbd636fe0f"
        ],
        "conflict": false,
        "detail": "Kilo uniform charlie tango papa india november bravo mike hotel uniform papa india alpha girder rampart zulu quarry foxtrot anchor juliet uniform jetty yankee whiskey cipher delta girder rampart foxtrot golf.",
        "token": "351502826687ed7a485ffac9"
      },
      {
        "item_id": "c064ebf5beb0",
        "id": "email:c064ebf5",
        "title": "Tango cipher keel lantern sextant foxtrot.",
        "why": "Golf golf tango.",
        "evidence": [
          "Victor cipher keel ember dossier kilo harbor echo girder kilo uniform cipher quarry zulu juliet uniform charlie golf harbor echo trellis girder...."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-15T18:34:53Z",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Alpha mortise lima uniform jetty romeo victor jetty rampart mike hotel uniform charlie girder delta mike beacon whiskey jetty romeo ingot kilo obelisk foxtrot girder romeo india november beacon keel echo.....",
        "token": "2dcd7db6c176bb45d6486028"
      },
      {
        "item_id": "2e1844db0092",
        "id": "imessage:2e1844db",
        "title": "Bravo mike harbor keel rampart mike.....",
        "why": "Fathom quebec ingot lantern..",
        "evidence": [
          "Foxtrot anchor quarry foxtrot anchor quebec oscar hotel nocturne sextant.."
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-12T16:40:40.495Z",
        "age_days": 4,
        "carried_from": "2026-09-12",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "babea1eb2c58"
        ],
        "conflict": false,
        "detail": "Papa obelisk lantern sextant mike hotel alpha girder ember keel ember keel echo girder xray papa obelisk yankee jetty lantern sextant foxtrot nocturne echo november uniform india harbor keel yankee...",
        "token": "3bdfd46f3b0b4edb76b82cbb"
      },
      {
        "item_id": "5208254110c8",
        "id": "email:52082541",
        "title": "Fathom kilo alpha foxtrot girder keel romeo....",
        "why": "Quarry mortise echo girder....",
        "evidence": [
          "Oscar ingot rampart mike oscar obelisk fathom kilo...",
          "Quebec bravo girder romeo victor papa....."
        ],
        "gate": "O1",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-12T05:00:54Z",
        "age_days": 4,
        "carried_from": "2026-09-12",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Mike beacon dossier quebec oscar obelisk yankee dossier xray juliet november ingot rampart foxtrot alpha mike beacon quarry sextant sierra plinth mortise lantern ember quebec victor jetty kilo harbor rampart fathom delta girder.",
        "token": "11c5085f8fbcc870c0985af5"
      },
      {
        "item_id": "eeb077b6fa27",
        "id": "email:eeb077b6",
        "title": "Plinth yankee jetty kilo beacon...",
        "why": "Ember xray whiskey cipher quarry sierra.....",
        "evidence": [
          "Whiskey papa beacon keel lima harbor kilo hotel anchor delta mike hotel anchor jetty.."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-16T09:30:01Z",
        "age_days": 0,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Charlie nocturne yankee juliet alpha zulu dossier delta anchor whiskey whiskey plinth sierra plinth sextant fathom xray quarry sierra plinth foxtrot nocturne yankee juliet.....",
        "token": "1f977fd1e85defdeb9cfc7ea"
      },
      {
        "item_id": "6e3a3500fee5",
        "id": "capture-sync:6e3a3500",
        "title": "Ember keel romeo ingot echo girder kilo........",
        "why": "Uniform papa ingot xray papa.",
        "evidence": [
          "Yankee papa ingot romeo plinth sextant mike bravo...."
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Ingot lantern yankee charlie trellis mortise lantern ember delta anchor juliet november beacon quebec oscar ingot ember keel romeo ingot echo anchor jetty lantern ember kilo november bravo zulu charlie tango plinth foxtrot golf.",
        "token": "b90e85c6b6bfc98a8c979f2c"
      },
      {
        "item_id": "de9701d57de0",
        "id": "capture-sync:de9701d5",
        "title": "Bravo zulu jetty ember rampart sextant fathom rampart.",
        "why": "Zulu dossier dossier quebec..",
        "evidence": [
          "Ember xray charlie mike uniform victor jetty....."
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Trellis zulu jetty echo tango plinth lima obelisk fathom xray cipher xray whiskey papa beacon juliet november hotel nocturne echo nocturne lima uniform papa oscar obelisk foxtrot girder xray juliet november ingot echo nocturne echo nocturne fathom kilo....",
        "token": "78ed1e76777e468e6aad0286"
      },
      {
        "item_id": "e4756413b899",
        "id": "capture-sync:e4756413",
        "title": "Plinth fathom delta tango charlie zulu dossier quebec....",
        "why": "India november.....",
        "evidence": [
          "Sierra plinth sierra papa bravo tango victor plinth fathom xray jetty yankee papa oscar ingot kilo november obelisk foxtrot..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "summary",
        "split": "work",
        "when": "2026-09-15T18:18:05.354000+00:00",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Jetty rampart mike oscar ingot romeo bravo mortise fathom quebec oscar obelisk sextant sierra victor jetty echo nocturne lantern ember kilo hotel harbor kilo alpha mortise sextant mike harbor romeo oscar victor whiskey cipher dossier dossier xray whiskey jetty kilo...",
        "token": "04fa25145654e2f9cc45261e"
      },
      {
        "item_id": "7579e2e25e03",
        "id": "capture-sync:7579e2e2",
        "title": "Fathom kilo alpha girder kilo beacon juliet obelisk...",
        "why": "Tango papa ingot echo........",
        "evidence": [
          "Delta trellis trellis sierra plinth fathom xray quarry foxtrot nocturne lantern ember quebec oscar obelisk foxtrot anchor delta anchor quarry lima harbor xray juliet anchor....."
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "baf14f963133"
        ],
        "conflict": false,
        "detail": "Hotel golf nocturne lima uniform india uniform papa ingot kilo beacon keel ember delta nocturne lantern sextant mortise fathom delta golf golf tango charlie mike obelisk foxtrot tango ingot ember kilo november ingot xray cipher quebec beacon dossier kilo..",
        "token": "61f6db5127b8ce0792a4bd98"
      },
      {
        "item_id": "6e1f5c237506",
        "id": "capture-sync:6e1f5c23",
        "title": "Quebec beacon keel lima uniform cipher xray.",
        "why": "Lantern sextant zulu quebec..",
        "evidence": [
          "Lima alpha mike uniform papa oscar ingot ember dossier kilo november",
          "Quebec beacon keel echo tango charlie girder keel yankee dossier kilo beacon quarry sextant...."
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Dossier keel lantern echo anchor delta trellis zulu juliet obelisk lantern romeo india harbor ember keel echo nocturne sierra ingot rampart fathom kilo harbor xray whiskey jetty echo november oscar victor india......",
        "token": "220fdd3b39ca49054e83610a"
      },
      {
        "item_id": "0a731a6de9c2",
        "id": "capture-sync:0a731a6d",
        "title": "Cipher juliet anchor juliet obelisk fathom kilo harbor rampart......",
        "why": "Fathom delta mike hotel nocturne",
        "evidence": [
          "Keel echo girder ember keel lantern echo november bravo girder delta mike oscar beacon keel rampart zulu quarry lima beacon dossier quebec india..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Quarry foxtrot november hotel harbor romeo india alpha mike uniform plinth sierra cipher delta trellis sierra ingot echo trellis mortise lima oscar ingot rampart mortise lantern yankee charlie mike beacon keel lantern romeo cipher quarry sextant sierra bravo tango india harbor keel lantern sextant sierra ingot.",
        "token": "4182f00efbce9d677ca263f4"
      },
      {
        "item_id": "208fbf6a82b1",
        "id": "capture-sync:208fbf6a",
        "title": "Sierra ingot ember delta nocturne yankee......",
        "why": "India nocturne fathom rampart.",
        "evidence": [
          "Bravo girder ember delta trellis girder xray papa victor jetty ember delta girder romeo..."
        ],
        "gate": "O1",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "November bravo trellis girder xray whiskey charlie zulu whiskey whiskey plinth lima obelisk fathom keel rampart zulu jetty lantern lantern lima oscar beacon quarry foxtrot girder keel echo nocturne sextant trellis trellis...",
        "token": "139753bdf1bac31e33f2ec1e"
      },
      {
        "item_id": "8889a8ea57e8",
        "id": "capture-sync:8889a8ea",
        "title": "Lantern ember dossier keel lantern romeo plinth fathom delta",
        "why": "Cipher juliet alpha foxtrot...",
        "evidence": [
          "November hotel november uniform papa obelisk lima oscar bravo tango victor papa beacon whiskey cipher..."
        ],
        "gate": "O1",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Rampart foxtrot tango charlie nocturne sierra cipher juliet anchor dossier delta girder rampart mike beacon quarry zulu jetty yankee dossier quarry sextant fathom ember keel ember xray cipher keel romeo plinth mortise fathom ember rampart sextant sierra india uniform papa obelisk",
        "token": "c81828ae090dc2bf6cedbc48"
      },
      {
        "item_id": "997eb1c18d43",
        "id": "capture-sync:997eb1c1",
        "title": "Zulu dossier delta anchor quebec bravo mortise sextant mortise.",
        "why": "Nocturne sierra....",
        "evidence": [
          "Quarry zulu quebec victor whiskey cipher juliet uniform cipher quarry sierra india harbor echo tango victor plinth fathom rampart zulu quebec victor plinth mortise sextant foxtrot anchor quarry..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T18:53:38.580185+00:00",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Sierra cipher delta trellis zulu dossier delta tango papa india uniform india harbor echo tango papa bravo mortise sextant fathom keel lima uniform cipher dossier kilo uniform plinth sierra bravo mortise yankee charlie golf november hotel harbor keel lima obelisk yankee papa india uniform...",
        "token": "7196a6e4ab4c623b067e865b"
      },
      {
        "item_id": "aa79772196e4",
        "id": "capture-sync:aa797721",
        "title": "Lima beacon whiskey juliet november......",
        "why": "Sextant fathom keel",
        "evidence": [
          "Jetty yankee charlie nocturne yankee dossier xray quarry sextant sierra plinth sierra victor jetty romeo plinth..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T18:53:38.580185+00:00",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Oscar oscar oscar obelisk sierra cipher xray charlie golf golf tango plinth mortise echo tango charlie trellis mike harbor romeo cipher keel lima oscar beacon delta anchor quarry sextant fathom quebec....",
        "token": "61c24b1ea23e47d4e5b0f1a6"
      },
      {
        "item_id": "04f4098c28d8",
        "id": "capture-sync:04f4098c",
        "title": "Alpha zulu dossier keel yankee jetty lantern sextant.......",
        "why": "Cipher juliet...",
        "evidence": [
          "Harbor kilo uniform jetty rampart fathom kilo harbor keel romeo victor jetty kilo harbor....",
          "Foxtrot tango cipher xray jetty yankee whiskey cipher dossier quebec plinth......"
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "missed-todos",
        "split": "work",
        "when": "2026-09-11T15:25:54.798476+00:00",
        "age_days": 5,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [
          "3df6ff27fe09"
        ],
        "conflict": false,
        "detail": "Keel romeo india hotel alpha girder keel lima uniform jetty lantern lantern romeo cipher juliet uniform india harbor xray whiskey plinth sierra ingot echo anchor jetty echo tango cipher juliet anchor quebec india nocturne fathom xray quarry lima obelisk foxtrot tango plinth..",
        "token": "8dd0b1ebf8429f0ecf256127"
      },
      {
        "item_id": "7e6ac49c263e",
        "id": "capture-sync:7e6ac49c",
        "title": "Bravo trellis girder ember quebec bravo tango cipher keel...",
        "why": "Whiskey papa beacon",
        "evidence": [
          "Bravo trellis girder kilo hotel harbor echo nocturne sextant trellis trellis girder delta golf tango plinth fathom quebec india harbor kilo november ingot rampart foxtrot november oscar beacon."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "missed-todos",
        "split": "work",
        "when": "2026-09-11T15:25:54.798476+00:00",
        "age_days": 5,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Quebec bravo zulu charlie girder keel rampart mike oscar beacon dossier quebec bravo girder kilo obelisk fathom delta trellis mortise lima uniform india hotel alpha trellis trellis foxtrot alpha mike beacon juliet hotel alpha zulu quarry foxtrot alpha mike oscar hotel november...",
        "token": "c975b11bbccb9d145167704e"
      }
    ],
    "week": [
      {
        "item_id": "a6b8a9fccfd9",
        "id": "email:a6b8a9fc",
        "title": "Rampart foxtrot november beacon dossier dossier....",
        "why": "Bravo girder rampart mike....",
        "evidence": [
          "India november obelisk fathom kilo hotel nocturne lantern..."
        ],
        "gate": "O3",
        "source": "GitHub",
        "origin": "email",
        "kind": "thread",
        "split": "work",
        "when": "2026-09-15T08:13:21Z",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "ef7c093e6450"
        ],
        "conflict": false,
        "detail": "Sierra victor papa victor india anchor quarry foxtrot alpha zulu quebec bravo trellis sierra papa obelisk sextant fathom quebec beacon keel ember dossier dossier delta trellis foxtrot tango ingot romeo bravo mike hotel harbor romeo plinth......",
        "token": "f4bf0f44a53b4b41d4271319"
      },
      {
        "item_id": "babea1eb2c58",
        "id": "imessage:babea1eb",
        "title": "Cipher juliet anchor quebec plinth fathom",
        "why": "Sierra ingot ember keel......",
        "evidence": [
          "Juliet obelisk sextant sierra papa beacon dossier delta mike.."
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-14T03:37:19.117Z",
        "age_days": 3,
        "carried_from": "2026-09-15",
        "carry_days": 2,
        "url": "",
        "jump_url": "",
        "related": [
          "2e1844db0092"
        ],
        "conflict": false,
        "detail": "Quebec bravo tango charlie mike hotel anchor jetty yankee juliet anchor quarry sextant mortise yankee whiskey juliet anchor juliet obelisk lima uniform victor plinth sierra cipher juliet hotel uniform....",
        "token": "9a479648d833fde3610a5ecf"
      },
      {
        "item_id": "5e439db9f8c5",
        "id": "imessage:5e439db9",
        "title": "Obelisk sierra india harbor rampart zulu quarry",
        "why": "Quarry sextant mortise lima..",
        "evidence": [
          "Cipher quarry lima hotel november uniform cipher....."
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-13T20:29:25.580Z",
        "age_days": 3,
        "carried_from": "2026-09-15",
        "carry_days": 2,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Anchor quebec india alpha zulu quarry sextant sierra victor papa beacon delta mike harbor romeo cipher quebec bravo mortise fathom delta girder kilo november oscar oscar hotel alpha tango cipher xray quarry foxtrot nocturne echo",
        "token": "d47fd1565018a8ca1c6ed687"
      },
      {
        "item_id": "f282ba1e7f61",
        "id": "email:f282ba1e",
        "title": "Oscar victor charlie tango victor.",
        "why": "Nocturne lima oscar beacon...",
        "evidence": [
          "Ingot rampart zulu dossier kilo hotel golf tango."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-12T12:00:13Z",
        "age_days": 4,
        "carried_from": "2026-09-15",
        "carry_days": 4,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Charlie golf harbor keel lantern ember rampart mike hotel uniform plinth sierra india harbor keel yankee whiskey plinth yankee quarry sierra india november bravo mortise romeo.",
        "token": "8660d5109c3a89e7a9c6a934"
      },
      {
        "item_id": "ffca78a41837",
        "id": "email:ffca78a4",
        "title": "Sextant zulu quarry sextant trellis mortise lima obelisk lima.....",
        "why": "Whiskey cipher juliet anchor....",
        "evidence": [
          "Plinth yankee charlie trellis zulu quarry mortise echo anchor whiskey cipher quebec ingot romeo oscar beacon dossier kilo november obelisk"
        ],
        "gate": "O2",
        "source": "Jira",
        "origin": "email",
        "kind": "thread",
        "split": "work",
        "when": "2026-09-14T19:27:41Z",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "https://example.atlassian.net/acme/widgets/pull/782",
        "related": [],
        "conflict": false,
        "detail": "Echo nocturne lantern sextant fathom kilo november beacon quebec victor papa obelisk foxtrot november bravo mike harbor xray juliet obelisk sierra papa bravo zulu whiskey papa bravo zulu juliet november beacon delta nocturne sextant trellis mike obelisk lantern echo anchor juliet uniform papa obelisk...",
        "token": "8ac855c30b934081df5060e5"
      },
      {
        "item_id": "a57a7d3d709d",
        "id": "imessage:a57a7d3d",
        "title": "Whiskey plinth lima oscar obelisk.....",
        "why": "Ingot xray jetty kilo uniform",
        "evidence": [
          "Kilo alpha girder rampart zulu...",
          "Girder delta anchor whiskey plinth yankee dossier dossier quarry fathom ember quebec.."
        ],
        "gate": "O3",
        "source": "iMessage",
        "origin": "imessage",
        "kind": "message",
        "split": "personal",
        "when": "2026-09-13T22:31:49.398Z",
        "age_days": 3,
        "carried_from": "2026-09-14",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Harbor kilo november ingot lantern lantern romeo ingot rampart mike obelisk foxtrot alpha foxtrot alpha mike oscar ingot echo trellis zulu quebec ingot kilo november beacon quebec bravo.......",
        "token": "bf5381fdfaac17bdd65002b8"
      },
      {
        "item_id": "d43c0696e5f9",
        "id": "email:d43c0696",
        "title": "Lima oscar bravo golf harbor romeo ingot ember xray papa",
        "why": "Jetty yankee....",
        "evidence": [
          "Fathom quebec india uniform victor jetty kilo uniform charlie mike oscar ingot rampart....."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "work",
        "when": "2026-09-15T19:59:47Z",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Charlie nocturne yankee quarry fathom xray juliet hotel alpha foxtrot tango india harbor xray quarry mortise echo trellis trellis mike oscar ingot xray charlie golf alpha girder delta tango plinth lima hotel alpha mortise yankee papa oscar ingot xray cipher xray..",
        "token": "e12139f6d6dc431f30fa55de"
      },
      {
        "item_id": "62dabdb6e657",
        "id": "email:62dabdb6",
        "title": "Lima hotel alpha zulu dossier kilo beacon quebec..",
        "why": "Anchor whiskey..",
        "evidence": [
          "Zulu quarry sierra india nocturne sextant trellis zulu juliet november beacon dossier quarry mortise yankee dossier quarry sierra cipher quarry....."
        ],
        "gate": "O3",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "work",
        "when": "2026-09-15T15:06:14Z",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Charlie mike harbor rampart mike oscar bravo zulu juliet harbor xray quarry zulu quebec oscar obelisk foxtrot alpha mike hotel alpha trellis mortise lima alpha tango ingot xray juliet anchor juliet anchor whiskey papa india alpha mortise...",
        "token": "29aacd3237615ac11aaaf95e"
      },
      {
        "item_id": "388f0ad8fdbf",
        "id": "email:388f0ad8",
        "title": "November oscar obelisk lantern lantern echo girder delta...",
        "why": "Keel ember quebec victor charlie trellis.....",
        "evidence": [
          "Ember dossier quarry mortise romeo india hotel alpha foxtrot tango victor whiskey papa india uniform plinth sextant zulu dossier quebec."
        ],
        "gate": "O1",
        "source": "Email",
        "origin": "email",
        "kind": "thread",
        "split": "personal",
        "when": "2026-09-16T05:30:55Z",
        "age_days": 0,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Zulu whiskey papa ingot rampart sierra cipher xray juliet hotel nocturne lantern lima harbor rampart foxtrot november bravo mike bravo tango india nocturne yankee juliet harbor romeo india uniform plinth mortise fathom xray jetty rampart mortise lima uniform plinth sierra....",
        "token": "124cf74975367dd0ec1a000e"
      },
      {
        "item_id": "413e4892d073",
        "id": "capture-sync:413e4892",
        "title": "Lima harbor xray quarry lima obelisk lantern ember delta tango.",
        "why": "Beacon juliet harbor rampart....",
        "evidence": [
          "Rampart sierra plinth yankee jetty echo november oscar victor jetty yankee quarry..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Sierra cipher quebec ingot lantern ember rampart foxtrot anchor quebec plinth sierra plinth fathom kilo harbor keel rampart sextant mike harbor ember rampart sierra cipher delta trellis foxtrot tango india hotel november oscar obelisk lima harbor ember rampart mortise echo november oscar....",
        "token": "b0a46516d91a75f417240d2b"
      },
      {
        "item_id": "3857fb910a96",
        "id": "capture-sync:3857fb91",
        "title": "Quebec victor jetty kilo uniform plinth.......",
        "why": "Rampart mike uniform india......",
        "evidence": [
          "Echo trellis foxtrot nocturne sierra cipher..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Echo anchor quebec bravo golf nocturne lima harbor ember kilo harbor keel ember keel ember kilo harbor romeo ingot rampart zulu dossier xray jetty romeo ingot kilo uniform papa india harbor xray jetty rampart mike hotel.....",
        "token": "31c4c06a139a632b947b6d43"
      },
      {
        "item_id": "6791598f95eb",
        "id": "capture-sync:6791598f",
        "title": "Girder xray whiskey charlie girder rampart mike beacon..",
        "why": "Lima alpha tango ingot xray papa",
        "evidence": [
          "Echo golf november oscar victor papa india november....."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Rampart mortise yankee quarry foxtrot tango plinth lima oscar victor jetty echo girder xray whiskey juliet uniform jetty yankee papa obelisk yankee quarry fathom kilo alpha zulu charlie golf nocturne yankee quarry sextant sierra india harbor keel yankee charlie...",
        "token": "cedd1bc7c16cf5905736e16b"
      },
      {
        "item_id": "05bfb9a3b4e6",
        "id": "capture-sync:05bfb9a3",
        "title": "Delta tango india hotel golf.....",
        "why": "Ingot rampart mortise yankee....",
        "evidence": [
          "Fathom ember rampart foxtrot....."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Sierra ingot ember xray juliet hotel nocturne fathom xray whiskey jetty kilo harbor rampart sextant trellis zulu juliet obelisk fathom keel ember delta anchor dossier delta",
        "token": "9961cbf170e946570a5f4038"
      },
      {
        "item_id": "358d3b645aa8",
        "id": "capture-sync:358d3b64",
        "title": "Kilo uniform charlie trellis foxtrot.....",
        "why": "Mike bravo trellis sierra india.",
        "evidence": [
          "Whiskey plinth mortise sextant foxtrot..."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "commitments",
        "split": "work",
        "when": "2026-09-14T19:57:07.650704+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Harbor romeo ingot lantern echo tango cipher dossier kilo hotel anchor dossier delta golf golf harbor echo november bravo trellis foxtrot november hotel harbor echo nocturne sierra ingot echo golf golf...",
        "token": "4ae7e587b2057d33582d2bc0"
      },
      {
        "item_id": "13e38e62570c",
        "id": "capture-sync:13e38e62",
        "title": "Dossier kilo uniform victor jetty lantern yankee.....",
        "why": "Beacon delta anchor quebec......",
        "evidence": [
          "Fathom rampart sextant mike bravo mike uniform india harbor echo nocturne sierra india alpha tango cipher dossier xray..",
          "India uniform papa ingot xray cipher juliet alpha"
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "summary",
        "split": "work",
        "when": "2026-09-14T21:58:37.071000+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "4ee800dd08a0"
        ],
        "conflict": false,
        "detail": "Juliet obelisk lima uniform papa ingot romeo india alpha foxtrot nocturne sierra cipher xray charlie trellis mortise yankee charlie trellis trellis sierra bravo trellis mortise fathom quebec bravo tango cipher delta girder romeo oscar oscar oscar......",
        "token": "6e8bca30d57fe1240527efc3"
      },
      {
        "item_id": "4ee800dd08a0",
        "id": "capture-sync:4ee800dd",
        "title": "Echo golf november obelisk fathom delta tango india anchor",
        "why": "Ingot echo trellis girder ember.",
        "evidence": [
          "Plinth foxtrot golf anchor whiskey plinth sierra cipher juliet alpha foxtrot nocturne fathom rampart......"
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "summary",
        "split": "work",
        "when": "2026-09-14T21:48:36.625000+00:00",
        "age_days": 2,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "13e38e62570c"
        ],
        "conflict": false,
        "detail": "Quebec ingot lantern sextant foxtrot girder keel echo golf nocturne fathom quebec plinth yankee whiskey charlie trellis mike harbor xray jetty kilo november uniform india harbor ember delta tango victor charlie zulu quarry sierra plinth yankee charlie nocturne sextant....",
        "token": "ee2fd436f248aa7e6eb13796"
      },
      {
        "item_id": "4dcc69484147",
        "id": "capture-sync:4dcc6948",
        "title": "Juliet harbor ember xray cipher dossier delta nocturne sextant....",
        "why": "Victor jetty kilo harbor.....",
        "evidence": [
          "Mike bravo mortise sextant sierra plinth yankee charlie golf nocturne...",
          "Lantern lantern echo golf golf alpha girder delta anchor dossier delta golf golf"
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [
          "8e172a07e324"
        ],
        "conflict": false,
        "detail": "Hotel golf tango cipher quarry lima obelisk foxtrot golf harbor ember quebec beacon whiskey whiskey whiskey cipher delta golf nocturne fathom rampart zulu quarry fathom xray charlie tango plinth sextant sierra bravo mortise echo tango india nocturne sierra india alpha zulu quarry fathom keel lantern....",
        "token": "2262f18bf593cff54159d41e"
      },
      {
        "item_id": "d095cbadeb21",
        "id": "capture-sync:d095cbad",
        "title": "Keel romeo bravo mike hotel alpha tango victor papa ingot..",
        "why": "Lima harbor romeo bravo mortise.",
        "evidence": [
          "Mortise sextant trellis sierra papa oscar beacon keel romeo...."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "todo-list-assistant",
        "split": "work",
        "when": "2026-09-15T05:39:06.764508+00:00",
        "age_days": 1,
        "carried_from": "2026-09-15",
        "carry_days": 1,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Golf nocturne sierra victor cipher keel lima oscar ingot rampart zulu quebec plinth yankee whiskey juliet harbor rampart mike uniform papa obelisk yankee dossier delta golf harbor ember quebec bravo tango ingot echo girder rampart zulu charlie golf tango india november hotel.",
        "token": "7c9d8177d469e2980e660a1f"
      },
      {
        "item_id": "600d3d72a496",
        "id": "capture-sync:600d3d72",
        "title": "Foxtrot tango victor india nocturne..",
        "why": "Trellis foxtrot..",
        "evidence": [
          "Whiskey jetty yankee papa bravo mike beacon quebec india anchor whiskey jetty yankee jetty echo golf golf anchor...",
          "Lantern yankee dossier quebec......"
        ],
        "gate": "O1",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "missed-todos",
        "split": "work",
        "when": "2026-09-11T15:25:54.798476+00:00",
        "age_days": 5,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Golf november oscar obelisk lantern sextant mike bravo golf alpha foxtrot girder rampart fathom ember kilo alpha girder kilo november ingot echo golf golf november beacon delta nocturne...",
        "token": "8f5c3cbb6725afebeb85f315"
      },
      {
        "item_id": "11aff1ad8b91",
        "id": "capture-sync:11aff1ad",
        "title": "Whiskey charlie girder romeo bravo mike.....",
        "why": "Ember quebec india.",
        "evidence": [
          "Hotel november oscar hotel anchor dossier quarry....",
          "Oscar bravo zulu quebec victor.."
        ],
        "gate": "O2",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "missed-todos",
        "split": "work",
        "when": "2026-09-11T15:25:54.798476+00:00",
        "age_days": 5,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Mike oscar beacon dossier xray papa victor cipher keel lantern sextant sierra papa victor plinth mortise echo anchor whiskey plinth sextant sierra papa obelisk lantern ember rampart foxtrot november beacon dossier...",
        "token": "ca590adcca99bdf14b41e92b"
      }
    ],
    "background": [
      {
        "item_id": "b34c33d4553b",
        "id": "finance:b34c33d4",
        "title": "Fathom xray jetty lantern ember kilo hotel anchor..",
        "why": "Harbor keel lima hotel.......",
        "evidence": [
          "Golf tango plinth sierra cipher keel echo girder keel ember keel lantern echo nocturne echo november....."
        ],
        "gate": "O1",
        "source": "Hub",
        "origin": "finance",
        "kind": "advisory",
        "split": "personal",
        "when": "2026-09-15T13:30:00Z",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "/finance",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "India uniform victor whiskey jetty kilo beacon quebec plinth foxtrot nocturne sierra ingot rampart zulu dossier kilo beacon keel rampart foxtrot november uniform jetty ember rampart fathom rampart fathom keel yankee quarry sextant trellis......",
        "token": "cf7433d42f190fe42db3604b"
      },
      {
        "item_id": "fb0ecc881e59",
        "id": "capture-sync:fb0ecc88",
        "title": "Dossier kilo november beacon delta tango papa bravo trellis",
        "why": "Lantern ember dossier keel",
        "evidence": [
          "Rampart sextant fathom delta girder ember rampart mike obelisk foxtrot tango papa bravo mike"
        ],
        "gate": "O3",
        "source": "Capture",
        "origin": "capture-sync",
        "kind": "day-recap",
        "split": "work",
        "when": "2026-09-15T18:07:50.015353+00:00",
        "age_days": 1,
        "carried_from": "",
        "carry_days": null,
        "url": "",
        "jump_url": "",
        "related": [],
        "conflict": false,
        "detail": "Ingot echo november beacon dossier xray quarry sextant mortise fathom rampart mike harbor keel yankee dossier kilo obelisk foxtrot anchor jetty yankee dossier quebec beacon quarry sextant sierra bravo girder xray juliet obelisk fathom ember dossier kilo harbor rampart mike...",
        "token": "0de37650f030dabcaf899b57"
      }
    ]
  },
  "deferred": [
    {
      "item_id": "58eb7bf1ed21",
      "code": "ROLE",
      "origin": "capture-sync",
      "title": "Victor india alpha girder xray jetty romeo...",
      "reason": "Anchor quarry mortise sextant foxtrot girder rampart fathom delta girder keel echo anchor...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f536001a9566",
      "code": "UNDECIDED",
      "origin": "calendar",
      "title": "Lima uniform cipher dossier kilo hotel.....",
      "reason": "Xray cipher keel..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "8e172a07e324",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Sextant sierra cipher xray cipher delta.....",
      "reason": "Kilo beacon juliet obelisk sierra papa obelisk lantern....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "29e74754bf5f",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Xray whiskey jetty ember.....",
      "reason": "Delta golf harbor rampart sierra bravo mike bravo golf....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "eae0783aa109",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Mike hotel golf alpha trellis..",
      "reason": "Obelisk sextant mike bravo mortise fathom delta trellis...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "8632a6d9c515",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Quarry sierra india uniform jetty",
      "reason": "Oscar hotel november oscar oscar hotel anchor whiskey.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3df6ff27fe09",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Ember dossier xray papa bravo mike obelisk..",
      "reason": "Lima harbor rampart mortise fathom kilo alpha foxtrot.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "32cf566a3579",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Sierra india uniform papa ingot kilo uniform..",
      "reason": "Uniform charlie trellis mike oscar hotel uniform charlie..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "148689faf901",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Victor papa beacon quebec victor charlie golf tango victor.",
      "reason": "Keel lima obelisk lima alpha girder romeo india uniform india anchor whiskey.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e05ca40af3e7",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Ingot kilo november obelisk yankee jetty.....",
      "reason": "Keel ember quebec bravo girder delta girder xray whiskey..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "c6162982ca23",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Golf anchor whiskey charlie mike......",
      "reason": "Trellis foxtrot tango india harbor xray whiskey jetty echo",
      "when": "",
      "source": ""
    },
    {
      "item_id": "ef7c093e6450",
      "code": "EVIDENCE",
      "origin": "email",
      "title": "Whiskey jetty kilo uniform cipher delta golf....",
      "reason": "Keel lantern lima alpha zulu juliet obelisk fathom delta..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "2a8be9242afa",
      "code": "EVIDENCE",
      "origin": "email",
      "title": "Lantern yankee quarry foxtrot anchor jetty romeo",
      "reason": "Lima hotel golf harbor kilo obelisk lantern yankee dossier",
      "when": "",
      "source": ""
    },
    {
      "item_id": "6e5457c56fe0",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Papa oscar hotel......",
      "reason": "India nocturne lima hotel anchor dossier kilo hotel.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "73fc06ea5f7e",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Hotel alpha mike bravo zulu whiskey.",
      "reason": "Girder romeo india harbor kilo obelisk fathom rampart mike",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e9f1e0c246db",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Lima obelisk fathom xray cipher..",
      "reason": "Xray whiskey plinth foxtrot nocturne echo tango charlie...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "155558b5bf45",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Bravo golf golf..",
      "reason": "Hotel nocturne sierra plinth sierra bravo girder romeo....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "1a8b330d4e04",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Ingot kilo uniform papa india.",
      "reason": "Ember xray jetty rampart zulu quarry mortise echo anchor..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "baf14f963133",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Charlie girder romeo ingot.",
      "reason": "Beacon delta golf tango papa victor charlie nocturne lima.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3235d848a155",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Victor jetty rampart mortise.....",
      "reason": "Lantern yankee papa india alpha foxtrot anchor quebec.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "90acee71fe89",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Nocturne lima beacon keel ember xray",
      "reason": "Keel lima oscar beacon delta trellis zulu quebec oscar....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "878ec2019b42",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Foxtrot nocturne sextant sierra cipher xray......",
      "reason": "Lantern ember rampart zulu quarry sextant sierra bravo....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "2f5d6df4eb2c",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Alpha zulu quarry fathom rampart sierra plinth...",
      "reason": "Sierra cipher quarry mortise fathom keel lantern lima.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "b1f037557ef4",
      "code": "EVIDENCE",
      "origin": "capture-sync",
      "title": "Echo anchor juliet alpha tango plinth fathom rampart",
      "reason": "Cipher keel echo golf alpha zulu whiskey papa bravo zulu..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3bc229fdc3db",
      "code": "D1",
      "origin": "calendar",
      "title": "Romeo plinth yankee.....",
      "reason": "Echo girder xray quarry sierra india anchor jetty ember rampart.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e9841e40238b",
      "code": "DONE",
      "origin": "calendar",
      "title": "Nocturne sierra plinth fathom ember quebec....",
      "reason": "Lima alpha mike oscar bravo zulu quarry sextant mike...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "fb834de153d2",
      "code": "DONE",
      "origin": "calendar",
      "title": "Oscar hotel alpha girder keel..",
      "reason": "Delta mike beacon dossier kilo hotel golf anchor....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "9ca6fca5ae28",
      "code": "DONE",
      "origin": "calendar",
      "title": "Foxtrot tango ingot xray cipher keel lima alpha trellis.",
      "reason": "Papa victor cipher delta trellis sierra......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "70a0ce6dc92e",
      "code": "DONE",
      "origin": "calendar",
      "title": "Delta anchor quebec india anchor delta tango papa bravo....",
      "reason": "Dossier delta nocturne lima harbor kilo alpha zulu jetty echo girder",
      "when": "",
      "source": ""
    },
    {
      "item_id": "5fe968557ade",
      "code": "DONE",
      "origin": "calendar",
      "title": "Sextant sierra bravo girder delta.",
      "reason": "Girder kilo uniform jetty romeo india..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3012907a6217",
      "code": "D2",
      "origin": "email",
      "title": "Anchor whiskey whiskey plinth lima harbor kilo...",
      "reason": "Jetty yankee dossier xray quarry lima alpha girder rampart zulu quebec victor",
      "when": "",
      "source": ""
    },
    {
      "item_id": "2641c9e37e5b",
      "code": "D2",
      "origin": "email",
      "title": "Obelisk yankee papa india november hotel golf..",
      "reason": "Anchor quebec india uniform papa ingot lantern ember...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "d064a2fa7fe7",
      "code": "D2",
      "origin": "email",
      "title": "Beacon juliet november beacon quebec.....",
      "reason": "Jetty ember xray juliet obelisk yankee juliet hotel harbor.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "7c834f182f42",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Dossier quebec ingot lantern yankee jetty kilo uniform jetty kilo obelisk sextant...",
      "reason": "Oscar beacon juliet harbor kilo uniform jetty rampart mike oscar victor..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "d45eb435bb2e",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Quebec oscar beacon juliet harbor kilo alpha mike....",
      "reason": "Kilo hotel golf alpha zulu dossier quebec beacon delta golf golf golf......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "30059b6e1caf",
      "code": "DONE",
      "origin": "imessage",
      "title": "Fathom delta anchor jetty romeo cipher quarry fathom quebec victor..",
      "reason": "Romeo bravo girder kilo uniform charlie golf anchor.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "6a38f5b9e372",
      "code": "DONE",
      "origin": "imessage",
      "title": "Mike hotel alpha mortise lantern yankee.....",
      "reason": "Charlie nocturne yankee quarry fathom kilo harbor...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "af063056bdf9",
      "code": "DONE",
      "origin": "imessage",
      "title": "Lantern lima hotel november beacon dossier quarry zulu",
      "reason": "Golf november uniform india nocturne echo golf harbor",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f21fb1d79d2b",
      "code": "DONE",
      "origin": "imessage",
      "title": "Ember rampart foxtrot tango papa oscar victor.....",
      "reason": "Quarry mortise echo tango cipher quebec victor india harbor..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3ebe6c029bde",
      "code": "DONE",
      "origin": "email",
      "title": "Ingot rampart sextant mike obelisk sextant zulu quarry foxtrot tango cipher delta trellis foxtrot nocturne....",
      "reason": "Delta nocturne fathom quebec india harbor ember dossier delta golf...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "c420cc6e3a18",
      "code": "DONE",
      "origin": "email",
      "title": "Anchor delta mike hotel alpha zulu quarry mortise fathom quebec plinth sextant sierra plinth...",
      "reason": "Foxtrot november ingot xray whiskey papa oscar...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "bbac8ae19a98",
      "code": "DONE",
      "origin": "email",
      "title": "Papa india november hotel golf harbor keel ember quebec ingot echo anchor dossier.",
      "reason": "Plinth lima beacon whiskey whiskey plinth yankee jetty",
      "when": "",
      "source": ""
    },
    {
      "item_id": "73d3e8125685",
      "code": "DONE",
      "origin": "email",
      "title": "Anchor whiskey whiskey jetty......",
      "reason": "Echo trellis trellis zulu whiskey whiskey whiskey charlie tango...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3b1db2da66ed",
      "code": "D2",
      "origin": "email",
      "title": "Beacon keel rampart sierra india november ingot romeo cipher juliet anchor juliet alpha tango cipher xray juliet uniform papa..",
      "reason": "Victor cipher quarry zulu whiskey cipher..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "bbfc4d03ab1b",
      "code": "DONE",
      "origin": "email",
      "title": "Lima uniform victor whiskey cipher quarry mortise sextant zulu jetty.",
      "reason": "Mike harbor romeo cipher xray whiskey papa......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "968f998bbc60",
      "code": "D2",
      "origin": "email",
      "title": "Golf november uniform plinth....",
      "reason": "Harbor echo golf nocturne sierra",
      "when": "",
      "source": ""
    },
    {
      "item_id": "83476b7496d2",
      "code": "D2",
      "origin": "email",
      "title": "Delta golf alpha zulu dossier xray juliet.......",
      "reason": "Charlie girder xray papa obelisk lima",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e6bbe4996924",
      "code": "D2",
      "origin": "email",
      "title": "Yankee charlie trellis zulu.",
      "reason": "Quebec beacon juliet anchor delta tango..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "adcfd92b409b",
      "code": "D2",
      "origin": "email",
      "title": "Girder keel lantern ember....",
      "reason": "Oscar bravo trellis trellis mike.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "ff1c0e5fe6c4",
      "code": "D2",
      "origin": "email",
      "title": "Whiskey jetty lantern sextant mike....",
      "reason": "November bravo golf anchor dossier..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "2d429fd66a0d",
      "code": "D2",
      "origin": "email",
      "title": "Sextant trellis mortise romeo ingot....",
      "reason": "Jetty echo anchor quarry sierra ingot echo..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "0cbc53dd93f7",
      "code": "DONE",
      "origin": "email",
      "title": "Juliet....",
      "reason": "Juliet hotel anchor quebec india nocturne fathom xray whiskey charlie",
      "when": "",
      "source": ""
    },
    {
      "item_id": "d6053727def5",
      "code": "D2",
      "origin": "email",
      "title": "Sextant foxtrot golf harbor xray.",
      "reason": "Dossier keel yankee quarry",
      "when": "",
      "source": ""
    },
    {
      "item_id": "9e60c8c1516b",
      "code": "D2",
      "origin": "email",
      "title": "Mike hotel anchor quarry foxtrot girder",
      "reason": "Jetty ember dossier delta anchor...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "70dec9eccc5d",
      "code": "D2",
      "origin": "email",
      "title": "Keel romeo oscar.",
      "reason": "Beacon quebec beacon delta anchor quebec india hotel.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "a29083551f2b",
      "code": "D2",
      "origin": "email",
      "title": "Mortise romeo ingot rampart zulu....",
      "reason": "Lantern lima beacon quarry zulu whiskey...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f46d623845f3",
      "code": "D2",
      "origin": "email",
      "title": "Plinth sextant fathom ember delta golf anchor.....",
      "reason": "Juliet harbor kilo.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "66db2c9c5e66",
      "code": "D2",
      "origin": "email",
      "title": "Obelisk yankee quarry foxtrot tango",
      "reason": "Anchor whiskey jetty....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "0a759fc0e11a",
      "code": "D2",
      "origin": "email",
      "title": "Alpha trellis trellis sierra papa victor.",
      "reason": "Sierra india......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "a4408f6148dd",
      "code": "D2",
      "origin": "email",
      "title": "Juliet november hotel....",
      "reason": "Keel romeo cipher...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "a3d3cf1ee17a",
      "code": "D2",
      "origin": "email",
      "title": "Foxtrot anchor juliet anchor delta.",
      "reason": "Lima hotel alpha girder",
      "when": "",
      "source": ""
    },
    {
      "item_id": "1034403b7a85",
      "code": "D2",
      "origin": "email",
      "title": "Kilo obelisk sextant sierra victor.....",
      "reason": "Lantern sextant trellis",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f6d567097e15",
      "code": "D2",
      "origin": "email",
      "title": "Ember quebec ingot xray jetty echo tango",
      "reason": "Quarry sextant zulu charlie zulu....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "1dd522b5114e",
      "code": "D2",
      "origin": "email",
      "title": "Cipher quarry sextant...",
      "reason": "Delta mike uniform",
      "when": "",
      "source": ""
    },
    {
      "item_id": "5ed012869bae",
      "code": "D2",
      "origin": "finance",
      "title": "Delta anchor jetty.....",
      "reason": "Cipher dossier kilo uniform cipher delta trellis sierra bravo trellis sierra....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "416d6ba14a7f",
      "code": "NOISE",
      "origin": "imessage",
      "title": "Delta tango.....",
      "reason": "Mike uniform cipher keel",
      "when": "",
      "source": ""
    },
    {
      "item_id": "8d3506534d5b",
      "code": "NOISE",
      "origin": "imessage",
      "title": "Quebec ingot echo november oscar ingot rampart zulu....",
      "reason": "Harbor xray papa victor jetty yankee.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "54b7e0df5a75",
      "code": "D2",
      "origin": "imessage",
      "title": "Bravo zulu charlie girder keel yankee whiskey juliet hotel",
      "reason": "November oscar ingot lantern",
      "when": "",
      "source": ""
    },
    {
      "item_id": "aa446bcea492",
      "code": "D2",
      "origin": "imessage",
      "title": "Romeo cipher juliet anchor delta tango victor papa victor plinth fathom keel...",
      "reason": "Dossier xray whiskey...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "a20f02f38169",
      "code": "D2",
      "origin": "packages",
      "title": "Kilo uniform victor papa ingot xray....",
      "reason": "Hotel anchor quebec victor cipher dossier delta nocturne..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "093231cea541",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Fathom xray jetty romeo ingot echo trellis...",
      "reason": "Tango plinth mortise sextant mortise echo november....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "fd7ccc8de473",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "India harbor keel lantern romeo plinth.....",
      "reason": "Trellis mortise lantern lantern sextant foxtrot tango india alpha mortise...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "99ed8e9be742",
      "code": "D4",
      "origin": "capture-sync",
      "title": "Whiskey plinth sierra plinth mortise fathom kilo...",
      "reason": "Obelisk sextant mortise romeo oscar ingot ember",
      "when": "",
      "source": ""
    },
    {
      "item_id": "d4ec83d83c7e",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Juliet alpha trellis sierra india anchor quarry...",
      "reason": "Dossier delta anchor juliet hotel harbor keel rampart sextant trellis girder.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "62b6312c4102",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Uniform papa obelisk foxtrot........",
      "reason": "Bravo golf tango victor plinth fathom keel yankee papa india harbor......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "b405b1b84d6a",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Anchor quebec beacon.",
      "reason": "Foxtrot anchor quebec india alpha foxtrot november oscar ingot",
      "when": "",
      "source": ""
    },
    {
      "item_id": "1a3ff335bc5d",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Quarry foxtrot november ingot xray quarry sierra.....",
      "reason": "Delta golf nocturne sierra papa ingot kilo......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "0d8aab8f1caa",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Lantern romeo india uniform...",
      "reason": "Rampart mike harbor romeo india hotel alpha",
      "when": "",
      "source": ""
    },
    {
      "item_id": "2346f1a0c7ca",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Oscar beacon juliet uniform plinth lima harbor.",
      "reason": "Xray juliet harbor xray jetty yankee papa.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "52d819e5c008",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Obelisk yankee juliet obelisk lima harbor..",
      "reason": "Whiskey plinth fathom delta golf golf......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "66f93182182e",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Romeo ingot ember....",
      "reason": "Tango victor plinth fathom ember delta.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "aa29027a98f7",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Juliet obelisk fathom delta mike harbor...",
      "reason": "Dossier quebec oscar oscar victor india.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "cf1c2b5dde7e",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Nocturne fathom rampart foxtrot.",
      "reason": "Bravo zulu charlie golf november obelisk",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e1d946a9e009",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Mortise echo tango......",
      "reason": "Dossier delta....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "fc284f738594",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Cipher juliet alpha tango victor....",
      "reason": "Oscar bravo tango",
      "when": "",
      "source": ""
    },
    {
      "item_id": "4212698cf310",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Quarry sextant foxtrot girder.......",
      "reason": "Kilo uniform.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "822852d89db8",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Victor whiskey",
      "reason": "Sierra plinth lima uniform india alpha..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "d7ad9d6f8632",
      "code": "DONE",
      "origin": "capture-sync",
      "title": "Echo tango ingot xray charlie trellis.",
      "reason": "Obelisk lima hotel anchor whiskey.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "eaa2ac67f799",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Papa india alpha zulu whiskey papa oscar.",
      "reason": "Quarry mortise yankee juliet uniform cipher juliet anchor quebec india..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "bbcf9c9f5bcb",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Zulu jetty lantern ember dossier..",
      "reason": "Girder xray papa bravo golf november obelisk lima oscar ingot kilo november ingot",
      "when": "",
      "source": ""
    },
    {
      "item_id": "6ed858713d10",
      "code": "D4",
      "origin": "capture-sync",
      "title": "Foxtrot november bravo tango...",
      "reason": "Kilo uniform india harbor kilo november bravo golf..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "fdd634449f8e",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Kilo uniform cipher keel lantern....",
      "reason": "Uniform charlie golf alpha zulu charlie girder xray juliet uniform...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "46ba90835db9",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Lima harbor rampart mike.....",
      "reason": "Mortise romeo cipher keel lantern ember delta",
      "when": "",
      "source": ""
    },
    {
      "item_id": "33816646e9b1",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Victor india alpha mortise echo nocturne...",
      "reason": "Girder xray papa ingot ember rampart zulu whiskey.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "3ece6e629a1e",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Hotel uniform papa obelisk lima.......",
      "reason": "Juliet alpha tango victor jetty ember rampart mortise lantern......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f815be3f1c0f",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Beacon delta tango papa obelisk lantern",
      "reason": "Plinth sextant mortise sextant.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "012bbc223364",
      "code": "AMBIENT",
      "origin": "capture-sync",
      "title": "Tango cipher xray juliet",
      "reason": "Lima uniform papa ingot echo golf nocturne echo nocturne......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "64fcb4ca5ab1",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Quarry sierra bravo tango...",
      "reason": "Obelisk foxtrot alpha mortise yankee juliet uniform jetty.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "26598f11828b",
      "code": "D4",
      "origin": "capture-sync",
      "title": "Quarry fathom keel rampart zulu.",
      "reason": "Fathom xray charlie mike oscar obelisk sextant.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "b7ed9200f008",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Echo nocturne yankee charlie.....",
      "reason": "Golf anchor dossier dossier xray cipher.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "0450c131a3fa",
      "code": "D4",
      "origin": "capture-sync",
      "title": "Lantern sextant zulu jetty yankee juliet.",
      "reason": "India harbor ember keel echo.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "f7a4c7e11ccb",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Charlie tango cipher delta anchor jetty..",
      "reason": "November beacon dossier keel lima uniform..",
      "when": "",
      "source": ""
    },
    {
      "item_id": "b419dd130c2e",
      "code": "D4",
      "origin": "capture-sync",
      "title": "Bravo mortise yankee whiskey......",
      "reason": "Nocturne lantern romeo oscar bravo zulu.......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "de2f066cee4e",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Plinth fathom keel echo girder keel rampart",
      "reason": "Uniform jetty rampart foxtrot anchor jetty......",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e845ac316170",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Echo trellis mike beacon keel.....",
      "reason": "Charlie girder rampart zulu juliet anchor juliet.",
      "when": "",
      "source": ""
    },
    {
      "item_id": "13d2f19aad5d",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Bravo mike beacon juliet obelisk lima..",
      "reason": "Mortise romeo india harbor echo trellis trellis foxtrot",
      "when": "",
      "source": ""
    },
    {
      "item_id": "10a4d7c195a1",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Lantern ember delta girder kilo...",
      "reason": "Mike bravo golf harbor rampart sierra plinth sierra...",
      "when": "",
      "source": ""
    },
    {
      "item_id": "e4a3520f1fba",
      "code": "NOISE",
      "origin": "capture-sync",
      "title": "Lima obelisk lima uniform plinth.",
      "reason": "Anchor delta girder ember keel ember",
      "when": "",
      "source": ""
    },
    {
      "item_id": "da8ceda51e95",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Delta anchor juliet uniform jetty.",
      "reason": "Tango papa ingot romeo ingot ember quebec.....",
      "when": "",
      "source": ""
    },
    {
      "item_id": "c2b65838da30",
      "code": "D1",
      "origin": "capture-sync",
      "title": "Victor jetty yankee quarry lima....",
      "reason": "Harbor romeo cipher dossier delta golf harbor echo anchor......",
      "when": "",
      "source": ""
    }
  ],
  "held_back": {
    "total": 110,
    "by_code": {
      "AMBIENT": 14,
      "D1": 14,
      "D2": 26,
      "D4": 5,
      "DONE": 24,
      "EVIDENCE": 22,
      "NOISE": 3,
      "ROLE": 1,
      "UNDECIDED": 1
    }
  },
  "ambient_held_back": 15,
  "carried": {
    "count": 26,
    "candidates": 43,
    "from_date": "2026-09-15"
  },
  "sources": {
    "email": "ok",
    "calendar": "ok",
    "imessage": "ok",
    "packages": "ok",
    "capture-sync": "ok",
    "oura": "ok",
    "finance": "stale"
  },
  "stages": {
    "carry": "ok"
  },
  "provenance": {
    "git_sha": "0fb5735",
    "deployed_at": "2026-09-16T04:08:19Z",
    "finished": true,
    "candidates_sha256": "d48e0eca4713ce01b7de1694f76b9501ebc38f24cac6839b239b7ed5ecf445b7"
  },
  "gather_warnings": {
    "_warnings": {
      "email": [],
      "calendar": [],
      "imessage": [],
      "packages": [],
      "carry": [
        "November bravo tango papa beacon juliet uniform charlie mike hotel anchor delta girder ember"
      ]
    }
  },
  "served_date": "2026-09-16",
  "hidden_count": 0
};
