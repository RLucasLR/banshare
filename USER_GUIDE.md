# banshare user guide

this doc explains how to actually use the bot. if you're looking for setup/dev info, check the main readme.

---

## table of contents

- [what even is a collection](#what-even-is-a-collection)
- [roles explained](#roles-explained)
- [getting started](#getting-started)
- [inviting servers](#inviting-servers)
- [joining a collection](#joining-a-collection)
- [banning users](#banning-users)
- [unbanning users](#unbanning-users)
- [looking up bans](#looking-up-bans)
- [viewing ban details](#viewing-ban-details)
- [editing bans](#editing-bans)
- [managing moderators](#managing-moderators)
- [collection settings explained](#collection-settings-explained)
- [evidence](#evidence)
- [audit logs](#audit-logs)
- [common questions](#common-questions)

---

## what even is a collection

a "collection" is just a group of servers that share bans. think of it like a ban list that multiple servers subscribe to.

one server creates the collection (they become the "owner"), then invites other servers to join. when anyone with mod permissions bans a user through the bot, that user gets banned from ALL servers in the collection at once.

```
┌─────────────────────────────────────────────┐
│               your collection               │
│                                             │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│   │ server  │  │ server  │  │ server  │    │
│   │    A    │  │    B    │  │    C    │    │
│   │ (owner) │  │(member) │  │(member) │    │
│   └─────────┘  └─────────┘  └─────────┘    │
│                                             │
│   ban someone = banned from all 3 servers   │
└─────────────────────────────────────────────┘
```

---

## roles explained

there are 3 levels of access in a collection:

### owner
- the server that created the collection
- can change any setting
- can add/remove moderators
- can invite/kick servers
- can delete the entire collection
- there's only one owner per collection

### moderator
- a user or role that can use ban commands
- can `/shareban`, `/unshareban`, `/lookup-shareban`, etc
- CANNOT change collection settings
- CANNOT add other moderators
- mods are added by user id or role id

### member server
- a server that joined the collection
- their users get protected by the shared ban list
- they can have mods too (if the owner adds their users/roles)
- can leave anytime with... actually there's no leave command yet lol, you'd have to ask the owner to kick you

---

## getting started

### creating a collection

run `/collection-create` in your server. you need to be the server owner or have administrator permission.

you'll get a menu to set:
- **name** - what you want to call the collection (required)
- **description** - optional, just for your reference

after creating, your server automatically becomes the owner server.

### checking your collection

run `/collection-info` to see:
- collection name/description
- list of member servers
- list of moderators
- current settings
- pending invites

---

## inviting servers

to invite another server:

1. you need the **server id** of the server you want to invite
2. run `/collection-invite <server_id>`
3. the bot will dm the owner of that server with an invite
4. they have 7 days to accept before it expires

### how to get a server id

1. enable developer mode in discord (settings → app settings → advanced → developer mode)
2. right click the server icon
3. click "copy server id"

### what if they're already in a collection?

they'll get a warning that they need to leave their current collection first. the invite still gets created, but they can't accept until they leave.

---

## joining a collection

if someone invited your server:

1. run `/collection-join`
2. if you have multiple pending invites, pick which one
3. you'll see the collection details and a toggle for "sync existing bans"
4. click confirm to join

### what's "sync existing bans"?

when you join with sync enabled, the bot will look at the collection's existing bans and ban those users from your server too. this is useful if you're joining an established collection with lots of bans already.

if you turn it off, you join "clean" - only future bans affect your server.

**heads up:** sync can take a while if there are lots of bans. like, potentially minutes for big collections.

---

## banning users

this is the main feature. run `/shareban` to start.

### the shareban flow

1. **target** - paste a user id, @mention someone, or type a username
2. **reason** - internal reason (other mods see this)
3. **user-facing reason** - what the banned user sees in their dm (optional)
4. **expiry** - when the ban should auto-lift (optional, if collection allows it)
5. **evidence** - upload screenshots/files (required if collection requires it)
6. **servers** - pick which servers to ban from (defaults to all)
7. **confirm** - review and execute

### target user options

you can identify the user in 3 ways:
- **user id**: `123456789012345678`
- **mention**: `@username`
- **username**: just type their name (bot will search)

user id is the most reliable. username search might find multiple people.

### reason vs user-facing reason

| field | who sees it | required |
|-------|-------------|----------|
| reason | mods only, in audit logs and lookup | yes |
| user-facing reason | the banned user (in dm) | no |

the user-facing reason is what goes in the ban dm. if you leave it blank and dms are enabled, they'll see a generic "you have been banned" message.

example:
- **reason**: "doxxing members, evidence in #mod-chat thread from 12/25"
- **user-facing reason**: "violation of community rules"

### privatise reason

there's a toggle called "privatise reason" in the ban menu. when enabled:
- the internal reason is hidden from other mods in different servers
- only mods from the server that created the ban can see the full reason
- other mods see "[reason hidden]"

useful if the reason contains sensitive info.

### expiry dates

if the collection allows expiry, you can set when the ban should automatically lift. format: `YYYY-MM-DD` or relative like `30d` for 30 days.

**note:** auto-unban isn't implemented yet lol. the expiry date is stored but you'd have to manually unban when it passes. it's on the todo list.

### server selection

by default, the ban goes to ALL servers in the collection. but you can toggle individual servers off if you only want to ban them from specific places.

the owner server (marked with ⭐) can't be deselected - bans always apply there.

---

## unbanning users

run `/unshareban` to revoke a ban.

you can identify the user by:
- user id
- username (searches active bans)

if the user has multiple active bans (from different collections), you'll pick which one to revoke.

unbanning:
1. marks the ban as inactive in the database
2. unbans the user from all servers they were banned from
3. optionally dms them that they've been unbanned

---

## looking up bans

`/lookup-shareban` lets you search the ban history.

### search options

| option | what it does |
|--------|--------------|
| `user` | find bans where this user is the target |
| `moderator` | find bans/actions performed by this mod |
| `username` | fuzzy search by username |
| `date` | filter to a specific date (format: YYYY-MM-DD) |

you can combine `date` with any other option.

### results

you get a paginated list showing:
- ban id
- target user
- moderator who issued it
- date
- status (active/inactive)

click a result to view full details.

---

## viewing ban details

`/view-banshare <ban_id>` shows everything about a specific ban:

- target user info
- moderator who created it
- timestamp
- reason (if you have permission to see it)
- user-facing reason
- expiry date
- which servers they're banned from
- evidence files (if any)

### downloading evidence

if the ban has evidence attached, there's a button to download it. evidence is only accessible to mods in the collection.

---

## editing bans

`/edit-shareban <ban_id>` lets you modify an existing ban.

you can change:
- reason
- user-facing reason
- expiry date
- privatise setting
- add more evidence

you CANNOT change:
- the target user (create a new ban instead)
- which servers (would need to unban + reban)

---

## managing moderators

only the collection owner can do this.

run `/collection-mods` to open the mod management menu.

### adding mods

click "add" then paste:
- **user mentions**: @user1 @user2
- **role mentions**: @Role1 @Role2
- **raw ids**: 123456789012345678

you can mix and match in one message. keep pasting until you're done, then type "done" or "stop".

### removing mods

same flow but with the "remove" button.

### user vs role mods

| type | how it works |
|------|--------------|
| user | that specific person is a mod |
| role | anyone with that role is a mod |

role-based is easier to manage - just give people the role in your server instead of adding them individually.

---

## collection settings explained

run `/collection-edit` to change these (owner only).

### dm on ban

when enabled, the bot tries to dm banned users to tell them they've been banned. the message includes the user-facing reason and which servers they're banned from.

**default: on**

if the user has dms disabled, nothing happens (no error).

### require evidence

when enabled, mods MUST attach at least one evidence file to every ban. the confirm button is disabled until they upload something.

**default: off**

useful for accountability, annoying for quick bans.

### allow expiry

when enabled, mods can set expiration dates on bans.

**default: on**

turn this off if you want all bans to be permanent.

### sync existing bans

this is a per-server setting, not collection-wide. when a new server joins with sync enabled, they inherit all existing bans.

**default: off** (the joining server chooses)

### logging enabled

when enabled, the bot posts audit logs to a channel named `#shareban-logs` in each server.

**default: on**

if the channel doesn't exist, the bot will dm the server owner about it.

### ban policy

what actually happens when you shareban someone:

| policy | what happens |
|--------|--------------|
| `ban` | user is banned from the server |
| `kick` | user is kicked (can rejoin) |
| `log_only` | nothing happens, just logged |

**default: ban**

`log_only` is useful if you want to track bad actors without actually banning them. maybe they're not in your server yet.

---

## evidence

### supported file types

- **images**: png, jpg, jpeg, gif, webp
- **videos**: mp4, webm
- **documents**: pdf, txt

### limits

- max 10 files per ban
- max 25mb per file
- max 100mb total per ban

### uploading during ban

when you're in the shareban flow, click the evidence button. the bot will send a message asking you to upload files. just paste/upload them one by one. type "done" when finished.

the bot deletes your messages as you upload (to keep the channel clean).

### adding evidence later

use `/edit-shareban` to add more evidence to an existing ban.

### viewing evidence

evidence is only visible to mods in the collection. use `/view-banshare` and click the evidence button.

---

## audit logs

if logging is enabled, the bot posts to `#shareban-logs` whenever something happens:

- ban created
- ban revoked
- moderator added/removed
- server joined/left collection
- settings changed
- evidence accessed

### log format

```
[Log: Ban Created]
Action performed in collection MyCollection

Performed By: @SomeMod
Target User: @BadUser (123456789)
Reason: being a jerk

Timestamp: 2025-12-31 15:30:00
```

### missing channel

if `#shareban-logs` doesn't exist:
1. the bot tries to dm the server owner
2. if that fails, the log is just... lost

so create the channel if you want logs.

---

## common questions

### can i be in multiple collections?

no. a server can only be in one collection at a time. this prevents conflicts where the same user might be banned in one collection but not another.

### what if i ban the wrong person?

use `/unshareban` immediately. the ban will be revoked from all servers.

### can banned users see who banned them?

only if you put it in the user-facing reason. the dm doesn't include the moderator's name by default.

### what happens if the bot is offline when i ban someone?

the ban only works through the bot. if you use discord's built-in ban, it won't sync to other servers. you'd need to run `/shareban` when the bot's back.

### can i transfer collection ownership?

not currently. you'd have to delete the collection and have the new owner create a fresh one. everyone would need to rejoin.

### how do i leave a collection?

if you're a member server (not owner):
- currently there's no command for this
- ask the collection owner to remove your server

if you're the owner:
- use `/collection-delete` (deletes the whole thing)
- or transfer ownership (not implemented yet)

### what's the max servers in a collection?

50 servers. if you need more... why?

### do bans sync to servers that join later?

only if they enable "sync existing bans" when joining. otherwise they start fresh.

### what if a mod goes rogue?

the owner can remove their mod status with `/collection-mods`. they should also probably audit recent bans with `/lookup-shareban moderator:@thatperson`.

### why isn't my ban working?

common issues:
1. bot doesn't have ban permissions in that server
2. the target has a higher role than the bot
3. the target is the server owner (can't ban owners)
4. the server isn't actually in your collection

---

## still confused?

ping the server owner or whoever set up the bot. this doc covers the basics but your specific setup might be different.
