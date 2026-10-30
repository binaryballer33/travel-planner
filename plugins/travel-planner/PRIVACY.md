# Privacy policy: travel-planner

_Last updated: October 28, 2026_

travel-planner is a free, open-source plugin for Claude Code, published under the MIT license by
[binaryballer33](https://github.com/binaryballer33). This page says what the plugin does with your data.

## The short version

- The plugin runs on your computer, inside your own Claude Code session. The author runs **no server**,
  receives **none of your data**, and the plugin has **no analytics, tracking or telemetry**.
- It never books, pays, signs in, creates accounts or solves CAPTCHAs, and it never asks for payment cards,
  passwords, passport numbers or other government IDs.
- Everything it produces is saved as files in the folder you run Claude Code in. You can delete those
  files at any time.

## What the plugin handles

- **Your trip request**: origin, destination, dates, number of travelers, and any preferences you add, such
  as budget, cabin, currency or must-haves.
- **An email address**, only if you give one. At the end of a run Claude asks for an address, and you can
  decline.
- **The results**: a trip data file (`.json`), the HTML dashboard, and, if you gave an address, an email file
  (`.eml`). These are written to your working folder.

## Where your data goes

Nothing is sent to the plugin's author. Running a trip does send parts of your request to these places:

| Destination | What it receives | Why |
| --- | --- | --- |
| Booking and travel sites in your browser (Airbnb, Booking.com, Expedia, Kayak, Skyscanner, Trip.com, Agoda, Hostelworld, Google Flights, Google Hotels, and similar) | Route, dates, traveler count and room count, as search terms in the page address | To read prices and build direct links. The plugin never logs in or pays. |
| Open-Meteo | Destination coordinates and trip dates | Weather forecast and monthly averages |
| OpenStreetMap (Overpass and Nominatim) | Place names and the coordinates of stays | Map places within 5 miles and place lookups |
| Wikipedia and Wikimedia Commons | Names of local dishes | Dish photos and credits |
| Restaurant websites | A normal page request | The restaurant's own public share image |
| Your mail tool | The summary email and attachments, addressed only to the address you gave | Only if you gave an address. Claude sends through a mail connector you have already set up (Gmail or Google Workspace, Resend) or through your own signed-in Gmail in Claude in Chrome. The plugin stores no mail credentials and has no mail account of its own. |

These services have their own privacy policies, which apply to what they receive.

## Claude and Anthropic

The plugin is a set of instructions and helper scripts that Claude follows. Your requests and the pages
Claude reads are processed by Claude under your own agreement with Anthropic, as described in
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). This plugin adds nothing to that.

## Storage and retention

- The plugin keeps nothing outside your working folder. The author keeps nothing, because the author never
  receives anything.
- Dashboards, trip data and email files stay on your computer until you delete them. If you email a
  dashboard, your mail provider keeps that email under its own policy.
- The dashboard is a single HTML file. Opening it in a browser makes ordinary web requests from your browser:
  the map library from cdnjs.cloudflare.com, map tiles from OpenStreetMap, and the photos from the sites that
  host them (Wikimedia Commons, restaurant websites). If you click a stay that has no saved nearby places, the
  page looks them up live from OpenStreetMap's Overpass and Nominatim services, sending that stay's
  coordinates. Your browser sends those requests, not the plugin's author.

## Your choices

- Don't give an email address, and no email is made or sent.
- Delete the files the plugin wrote in your working folder to remove its output.
- Uninstall with `claude plugin uninstall travel-planner@shaqs-claude-plugins`.

## Changes

If this policy changes, the new version is published in this file in the
[plugin's repository](https://github.com/binaryballer33/shaqs-claude-plugins), with a new date at the top.

## Contact

Questions or concerns: open an issue at
[github.com/binaryballer33/shaqs-claude-plugins/issues](https://github.com/binaryballer33/shaqs-claude-plugins/issues).
