import '@logseq/libs';
import {BlockEntity} from "@logseq/libs/dist/LSPlugin";
import { SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin.user';

/**
 * entry
 */

const jiraRegExp: RegExp = /{{{j (?<jira>[0-9]+)}}}(\(#.*?\))?/g;
const pageSize: number = 50;

function main() {

    logseq.useSettingsSchema(settings);

    logseq.Editor.registerSlashCommand('Get Jira Details for Selection', (_) => {
        return updateJiras('selection');
    })

    logseq.Editor.registerSlashCommand('Create Jira', (_) => {
        return createJira();
    })

    logseq.Editor.registerSlashCommand('Get Jira Details for Page', (_) => {
        return updateJiras('page');
    })

    logseq.App.registerCommand('jiraDetails', {
        key: 'jiraDetails',
        label: 'Get Jira Details for Selection',
        desc: 'Add up to date status information to Jiras',
        keybinding: {binding: 'mod+alt+j'}
    }, (e) => {
        return updateJiras('selection');
    })
}

async function createJira() {
    const curBlock: BlockEntity | null = await logseq.Editor.getCurrentBlock();

    if (curBlock) {
        const block: BlockEntity | null = await logseq.Editor.getBlock(curBlock.uuid,{includeChildren: true});
        if (block){
            // The first line is the summary all the lines underneath are the description
            const summary = block.content;
            // Get the issue type from the final #tag - if none assume bug
            let type: string | undefined = 'bug';
            const typeMatch:RegExpMatchArray | null = summary.match(/^.*(?<type>#.+)$/);
            if (typeMatch){
                type = typeMatch.groups?.type;
            }
            const description = addChildrenToDescription(block, "", 0);
            //console.log(summary, description);
            const key = await createJiraViaAPI(summary, description, type);
            if (key){
                const newContent = summary + '{{{j ' + key + '}}}'
                await logseq.Editor.updateBlock(block.uuid,newContent);
            }
        }
    }
}

function addChildrenToDescription(block:BlockEntity,description: string,tabs: number):string {
    let newDescription = description;
    const children = block.children;
    const bullet = tabs ? "- " : "";
    if (children instanceof Array<BlockEntity>){
        for(let child of children as Array<BlockEntity>){
            newDescription = newDescription + "\n" + "   ".repeat(tabs) + bullet + child.content;
            newDescription = addChildrenToDescription(child,newDescription,tabs + 1);
        }
    }
    return newDescription;
}

async function createJiraViaAPI(summary:string, description:string, type:string | undefined):Promise<string>{
    // Build the jira lists for the in clauses

    const url:string = `${logseq.settings?.jiraURL}/rest/api/2/issue/`;
    const data = {
        "fields": {
            "project":
                {
                    "key": logseq.settings?.project
                },
            "summary": summary,
            "description": description,
            "issuetype": {
                "name": type || 'bug'
            }
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        body:JSON.stringify(data),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${logseq.settings?.APIToken}`,
            'X-Atlassian-Token': 'no-check',
            'user-agent':''
        }
    });
    const details = await response.json();
    if (response.status >= 300) {
        console.log(details?.errorMessages.join());
        return "";
    }

    return details.key;
}


async function updateJiras(scope: string){
    try {
        if (scope === 'page'){
            await updatePage();
        } else {
            await updateSelection();
        }
    } catch (e) {
        // @ts-ignore
        console.log('logseq-jira', e.message);
    }
}

async function updatePage() {
    const blocks: BlockEntity[] = await logseq.Editor.getCurrentPageBlocksTree();
    if (blocks) {
        // First get a map of all the jiras in the blocks
        const blockMap = new Map<BlockEntity,string[]>();
        buildBlockMap(blocks,blockMap);
        await processBlockMap(blockMap);
    }
}

async function updateSelection() {
    let selection: BlockEntity[] | null = await logseq.Editor.getSelectedBlocks();
    const blockMap = new Map<BlockEntity,string[]>();
    //console.log(selection);
    if (!selection || selection.length === 0) {
        const block: BlockEntity | null = await logseq.Editor.getCurrentBlock();
        if (block){
            selection = [block];
        }
    }
    if (selection){
        for (let b of selection){
            addJirasFromBlock(b,blockMap);
        }
    }

    await processBlockMap(blockMap);
}


async function processBlockMap(blockMap:Map<BlockEntity,string[]>) {
    //console.log("Blocks",blockMap);

    // Build a query to get the jira details from Atlassian
    const jiras: any[] = await getJiras(blockMap.values());

    console.log("Jiras",jiras);

    // Now build a map of json issues to the actual json details
    const issuesMap = new Map<string, any>();
    for (let jira of jiras) {
        issuesMap.set(jira.key, jira);
    }

    //console.log("Issues", issuesMap);

    // Now for each block in the blockMap replace the jiras with the status details
    const updates: Promise<any>[] = [];
    let count: number = 0;
    blockMap.forEach((jiras, block) => {
        // For each Jira get the replacement string with updated status details
        const swaps: string[] = jiras.map(j => getUpdatedJiraString(j, issuesMap.get("DEV-" + j)));
        count += swaps.length;
        //console.log("Swaps",swaps);
        const newContent = block.content.replace(jiraRegExp, () => swaps.shift() as string);
        updates.push(logseq.Editor.updateBlock(block.uuid, newContent));
    });
    await Promise.all(updates);

    await logseq.UI.showMsg("Updated " + count + " jira entries", "success");

    console.log("Done");
}

function getUpdatedJiraString(jiraNumber:string, jira:any):string{
    const jiraString = "{{{j " + jiraNumber + "}}}";
    let statusString = "jira not found";
    const parts: string[] = [];
    if (jira){
        // Get the version
        const versions = jira.fields.customfield_10303;
        const versionList = versions ? Array.isArray(versions) ? versions.map(v => makeTag(v.name)) : [versions.name] : null;
        parts.push(versionList ?  versionList.join(" ") : "#unassigned");

        // Get the status
        parts.push(jira.fields.status.name);

        // Check if this is flagged as core
        const labels = jira.fields.labels;
        if (labels && labels.includes('core')) parts.push('⭐');
        statusString = parts.join(" ");
    }

    return jiraString + "(" + statusString + getTime() + ")";

}

function buildBlockMap(blocks: BlockEntity[], map:Map<BlockEntity,string[]>){
    for(let block of blocks){
        addJirasFromBlock(block,map);
        if (block.children && block.children instanceof Array<BlockEntity>){
            buildBlockMap(block.children as BlockEntity[],map);
        }
    }
}

function addJirasFromBlock(block: BlockEntity, map:Map<BlockEntity,string[]>){
    // First get the jiras
    if (!block) return;

    const content: string = block.content;

    if (!content) return;

    let newContent = content;

    // First convert jiras with the full reference to shortcut syntax
    newContent = newContent.replaceAll(/\[DEV-([0-9]+)]\(https:\/\/.*?\/DEV-[0-9]+\)/g, '{{{j $1}}}');

    // Search for Jira numbers based on the logseq shortcut syntax
    const jiraMatch: Iterable<RegExpMatchArray> = newContent.matchAll(jiraRegExp);

    // If we have jiras, replace them with the jira followed by its status
    if (jiraMatch) {
        const jiras: string[] = Array.from(jiraMatch, match => match.groups?.jira as string);
        if (jiras.length)  map.set(block, jiras);
    }
}

async function getJiras(values:IterableIterator<string[]>): Promise<any[]> {
    // Flatten the map into an array of jiras
    const jiras:string[] = [];
    for (let v of values){
        for (let s of v){
            jiras.push("DEV-"+s);
        }
    }

    // Split the list into sub-lists of 100 jiras each
    const lists:Array<Array<string>> = [];
    while(jiras.length){
        lists.push(jiras.splice(0,pageSize));
    }

    // For each sub-list get the jiras
    const issues: any[] = await Promise.all(lists.map((j,i)=>getPageOfJiras(j.join(),i)));

    // Convert the sets of issues into a single list
    return issues.flat();
}

async function getPageOfJiras(jiraList:string,i:number):Promise<any[]>{
    // Build the jira lists for the in clauses
    let jql:string = "key in (" + jiraList + ")";

    const url:string = `${logseq.settings?.jiraURL}/rest/api/2/search?jql=${jql}&fields=status,labels,customfield_10303&maxResults=${pageSize}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${logseq.settings?.APIToken}`
        }
    });
    const details = await response.json();
    if (response.status >= 300) {
        console.log(details?.errorMessages.join());
        return [];
    }

    return details.issues;
}

function makeTag(text: string) {
    return text ? '#' + text.replaceAll(" ", "-") : text;
}

function getTime(): string {
    if (!logseq.settings?.showTime) return "";

    const now: Date = new Date();
    const hours: number = now.getHours();
    const minutes: number = now.getMinutes();
    const seconds: number = now.getSeconds();

    return " " + padTo2Digits(hours) + ":" + padTo2Digits(minutes) + ":" + padTo2Digits(seconds);

}

function padTo2Digits(num: number) {
    return num.toString().padStart(2, '0');
}

const settings: SettingSchemaDesc[] = [
    {
        key: "jiraURL",
        description: "Base url for atlassian",
        type: "string",
        default: "https://company.atlassian.net",
        title: "Base URL for Atlassian",
    },
    {
        key: "APIToken",
        description: "Base64 encoded API token",
        type: "string",
        default: "",
        title: "JIRA API Token",
    },
    {
        key: "showTime",
        description: "Show a timestamp at the end of the status to show when the status was updated",
        type: "boolean",
        default: false,
        title: "Show last updated timestamp"
    },
    {
        key: "project",
        description: "The JIRA project in which to create new Jiras",
        type: "string",
        default: "DEV",
        title: "Jira Project for new Jiras"
    }
];

logseq.ready(main).catch(console.error);