# LogSeq Jira Integration
A collection of tools to help synchronise issues in LogSeq with the corresponding details from Atlassian.

## Retrieve issue details from Jira
There are two slash commands 
- Get Jira Details for Page - this will scan the entire page for jira entries in the short form `{{{j <JIRA>}}}` and put the status details after them in brackets.  If there are Jira entries in the full format of `[<JIRA>](<url to jira>)` these will be converted to the short form first.
- Get Jira Details for Selection - this will only scan the selected blocks.  If no blocks are selected it will scan the block on which the cursor is place.  The keyboard shortcut for this option is mod-alt-j.

## Create an Issue
This is a work in progress and currently fails with XSRF check failures.  

The idea is to have a slash command that will take the current block as the summary of a Jira (with the type defaulting to bugh OR taken from a hashtag at the end e.g. #bug). Any lines indented under the summary will be taken as the description.
Once the Jira is created the Jira Number will be appended to the summary in the format `{{{j <JIRA>}}}`.

### License
MIT
