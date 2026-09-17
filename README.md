# Gsheets-to-ics
Javascript to convert a list of events (one per row) in a table in one or more Google Sheets and write out a combined iCal standard ics file.

'''
node Gheets-to-ics.js {google sheet ID}[,{Google sheet ID}] {output file name}.ics
'''
Configuration file is **Gsheets-to-ics.conf**

Expects GOOGLE_API_KEY to be set as an environment variable.

Only the first sheet (tab) in each Google Sheet will be selected.
That sheet needs to contain a table of events, starting somewhere in the first 10 rows
The table should have the column names described in **Gsheets-to-ics.conf**
- organiser - The event organiser (organiser can be a link)
- name - The event name
- quarter - one of these values: Q1, Q2, Q3, Q4
- start - a valid date, start date of conference
- end - a valid date, end date of conference
- city - city where event will take place
- country - country where event will take place
- region - region where event will take place
- topics - text or description
- link - link to the event's website

Valid dates are anything Google Sheets treats as a date and stores as a date serial. 
Generally, if date formatting works on the cell, then it's serialised as a valid date,
(if you are entering just dd/mm or similar for events _next year_, make sure the year doesn't default to this year). 
You can have rows with invalid dates; e.g. event date is not confirmed, use "TBD" or "TBC". We just skip those rows.

iCal entry will only be written if:
- name, quarter, organiser, city, country, region are not blank
- organiser is Q1, Q2, Q3, Q4
- start and end are valid dates
- the end date is > 30 days in the past
- end date >= start date
- end date is less than 10 days after start date
  
You can merge more than one sheet - pass sheet IDs comma-separated

The table stops being scanned when the following columns are empty:
name, quarter, start, end, city, country, region

