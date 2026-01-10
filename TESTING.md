# Banshare Bot Testing Guide

ok so this guide will walk you through testing the bot. just follow each step and write down anything that seems broken or weird

 

## Before You Start

### What Youll Need

- 3 Discord servers where your an admin or owner
- 2 or 3 test accounts so you can test banning people
- The bot added to all 3 servers
- Some test files like screenshots or images for evidence testing
- Something to write notes on

### Quick Setup Checklist

-  Bot is online and responding
-  Bot is added to Server A which will be the owner server
-  Bot is added to Server B which will join the collection
-  Bot is added to Server C which will recieve an invite
-  You have a test account ready to be banned and make sure this account is NOT an admin
-  Bot has Ban Members permission in all servers
-  Bot has Send Messages permission in all servers

 

## Part 1: Basic Bot Check

### Test 1.1 Check if the bot is alive

1. Go to any server where the bot is added
2. Type `/ping`
3. The bot should respond with a message

Pass: Bot responds  
Fail: No response or error message

 

## Part 2: Creating a Collection

### Test 2.1 Create your first collection

1. Go to Server A this will be your main owner server
2. Type `/collection-create`
3. Fill in the name as Test Collection
4. Add a description like A collection for testing
5. Press enter or click confirm

Pass: Bot says the collection was created successfully  
Fail: Error message or nothing happens

### Test 2.2 Check collection info

1. Stay in Server A
2. Type `/collection-info`
3. You should see the name Test Collection and your description and Server A listed as the owner and no other servers yet

Pass: All info shows correctly  
Fail: Missing info or wrong info

### Test 2.3 Try creating a second collection

This should fail since your already in one

1. Stay in Server A
2. Type `/collection-create` again
3. Try to create another collection

Pass: Bot tells you that your already in a collection  
Fail: Bot lets you create another collection

 

## Part 3: Inviting Servers

### Test 3.1 Get a server ID

Before inviting you need to know how to get a server ID

1. Open Discord Settings
2. Go to Advanced under App Settings
3. Turn on Developer Mode
4. Right click on Server Bs icon in the sidebar
5. Click Copy Server ID
6. Paste it somewhere youll need this

### Test 3.2 Invite Server B to your collection

1. Go to Server A
2. Type `/collection-invite`
3. Paste the Server ID from Server B
4. Press enter

Pass: Bot says invite was sent  
Fail: Error message

### Test 3.3 Check that the invite is pending

1. In Server A type `/collection-info`
2. Look for a Pending Invites section
3. Server B should be listed there

Pass: Server B appears in pending invites  
Fail: Nothing shows up

### Test 3.4 Try inviting the same server again

This should fail

1. In Server A type `/collection-invite`
2. Use the same Server ID again

Pass: Bot tells you an invite already exists  
Fail: Bot creates a duplicate invite

 

## Part 4: Joining a Collection

### Test 4.1 Accept the invite

1. Go to Server B
2. Type `/collection-join`
3. You should see the invite from Server A
4. Look at the details shown
5. Theres an option for sync existing bans leave it OFF for now
6. Click confirm or accept

Pass: Bot says youve joined the collection  
Fail: Error or nothing happens

### Test 4.2 Verify Server B is now in the collection

1. In Server B type `/collection-info`
2. You should see Test Collection as the name and Server A listed as owner and Server B listed as member

Pass: Both servers appear correctly  
Fail: Missing or wrong information

### Test 4.3 Check from Server A too

1. Go back to Server A
2. Type `/collection-info`
3. Server B should now appear as a member not in pending anymore

Pass: Server B moved from pending to members  
Fail: Server B still in pending or missing

 

## Part 5: Banning Users

This is the main feature

### Test 5.1 Ban a test user

Important make sure your test account is in BOTH Server A and Server B before this test

1. Go to Server A
2. Type `/shareban`
3. For the target either paste the test accounts user ID or mention them or type their username
4. For reason type Testing the ban feature
5. For user facing reason which is optional type Youve been banned for testing
6. Skip the expiry option
7. Skip evidence for now
8. Review the servers both A and B should be selected
9. Click confirm

Pass: Bot says ban was successful  
Fail: Error message or ban doesnt work

### Test 5.2 Check if the user is actualy banned

1. In Server A go to Server Settings then Bans
2. Look for your test account they should be there
3. Do the same in Server B

Pass: User is banned in BOTH servers  
Fail: User is missing from one or both ban lists

### Test 5.3 Check if the user got a DM

Only if DM on Ban is enabled which it should be by default

1. Log into your test account
2. Check DMs from the bot
3. The message should mention that they were banned and the user facing reason you typed and which servers they were banned from

Pass: DM received with correct info  
Fail: No DM or wrong information

### Test 5.4 Look up the ban you just created

1. In Server A type `/lookup-shareban`
2. Set the user option to your test account
3. Press enter

Pass: Your ban shows up in the results  
Fail: No results or wrong ban shown

### Test 5.5 View ban details

1. From the lookup results note the Ban ID
2. Type `/view-banshare`
3. Enter that Ban ID
4. Check all the details shown

You should see target user info and your name as the moderator and the reason you typed and the user facing reason and status Active and both servers listed

Pass: All details are correct  
Fail: Missing or wrong details

 

## Part 6: Unbanning Users

### Test 6.1 Unban the test user

1. In Server A type `/unshareban`
2. Enter the test accounts info like ID or mention or username
3. Confirm the unban

Pass: Bot says unban was successful  
Fail: Error message

### Test 6.2 Verify the user is unbanned

1. In Server A go to Server Settings then Bans
2. The test account should NOT be there anymore
3. Check Server B too

Pass: User is unbanned from BOTH servers  
Fail: User still banned in one or both

### Test 6.3 Look up the old ban

1. Type `/lookup-shareban`
2. Find the ban you created earlier
3. It should now show as Inactive or Revoked

Pass: Ban status changed to inactive  
Fail: Still shows as active

 

## Part 7: Evidence Feature

### Test 7.1 Create a ban with evidence

1. Make sure your test account is back in both servers first
2. Type `/shareban` in Server A
3. Fill in the target and reason
4. When you get to the evidence step click to add evidence
5. Upload 1 or 2 image files screenshots work great
6. Type done when finished
7. Complete and confirm the ban

Pass: Ban created with evidence attached  
Fail: Error during upload or evidence not saved

### Test 7.2 View the evidence

1. Type `/view-banshare` with the new bans ID
2. Look for an evidence button or section
3. Click to view or download the evidence
4. Make sure its the same files you uploaded

Pass: Evidence is viewable and matches what you uploaded  
Fail: Evidence missing or corrupted

### Test 7.3 Add more evidence to an existing ban

1. Type `/edit-shareban` with the ban ID
2. Find the option to add more evidence
3. Upload another file
4. Save the changes
5. View the ban again you should now see 3 or more files

Pass: New evidence was added  
Fail: Cant add or new evidence doesnt appear

 

## Part 8: Editing Bans

### Test 8.1 Edit a bans reason

1. Type `/edit-shareban` with an active bans ID
2. Change the reason to something different
3. Save the changes
4. Use `/view-banshare` to check it updated

Pass: Reason changed successfully  
Fail: Old reason still shows

### Test 8.2 Edit the user facing reason

1. Type `/edit-shareban` with the same ban
2. Change the user facing reason
3. Save

Pass: User facing reason updated  
Fail: Didnt change

### Test 8.3 Test the privatise reason option

1. Edit the ban again
2. Turn on privatise reason
3. Save
4. Go to Server B and try to view the same ban
5. The reason should say reason hidden or somthing similar

Pass: Reason is hidden in other servers  
Fail: Full reason still visible everywhere

 

## Part 9: Managing Moderators

### Test 9.1 Add a user as a moderator

1. In Server A type `/collection-mods`
2. Click Add
3. Mention someone like your alt account or a friend
4. Type done when finished
5. Use `/collection-info` to verify they appear as a mod

Pass: User appears in moderator list  
Fail: User not added

### Test 9.2 Test if the new mod can use commands

1. Log into the moderator account or have them try
2. In Server A try `/shareban`
3. They should be able to start the ban process

Pass: Mod can use ban commands  
Fail: Permission denied

### Test 9.3 Test that mods CANT change settings

1. As the moderator not owner try `/collection-edit`
2. It should fail or show a permission error

Pass: Mod is blocked from settings  
Fail: Mod can change settings which is a security issue

### Test 9.4 Add a role as moderator

1. In Server A create a role called Ban Manager or use an existing one
2. Type `/collection-mods`
3. Click Add  
4. Mention the role
5. Type done
6. Give someone that role
7. They should now be able to use `/shareban`

Pass: Role based mod permissions work  
Fail: Role doesnt grant access

### Test 9.5 Remove a moderator

1. Type `/collection-mods`
2. Click Remove
3. Select the user you added earlier
4. Confirm
5. That person should no longer be able to use `/shareban`

Pass: Mod removed and cant use commands anymore  
Fail: Mod still has access

 

## Part 10: Collection Settings

### Test 10.1 Open settings menu

1. In Server A as the owner type `/collection-edit`
2. You should see a menu with all the settings

Pass: Settings menu appears  
Fail: Error or no menu

### Test 10.2 Turn OFF DM on Ban

1. Find the DM on Ban setting
2. Turn it off
3. Save
4. Create a new test ban
5. The banned user should NOT recieve a DM this time

Pass: No DM sent  
Fail: DM still sent

### Test 10.3 Turn ON Require Evidence

1. Edit settings and turn on Require Evidence
2. Save
3. Try to create a new ban WITHOUT uploading evidence
4. The confirm button should be disabled or you should get an error

Pass: Cant ban without evidence  
Fail: Ban goes through without evidence

### Test 10.4 Turn OFF Allow Expiry

1. Turn off the Allow Expiry setting
2. Save
3. Try to create a new ban
4. The expiry date option should be gone or disabled

Pass: Cant set expiry dates  
Fail: Expiry option still available

### Test 10.5 Test the Ban Policy setting

Try each option

Policy ban
1. Set policy to ban
2. Shareban a user
3. They should be fully banned

Policy kick
1. Set policy to kick
2. Shareban a user
3. They should be kicked but can rejoin

Policy log only
1. Set policy to log only
2. Shareban a user
3. Nothing should happen to them but the action is logged

Pass: Each policy works correctly  
Fail: Wrong action taken

 

## Part 11: Audit Logs

### Test 11.1 Create the log channel

1. In Server A create a text channel named exactly shareban-logs
2. Make sure the bot can send messages there

### Test 11.2 Check if logs appear

1. Make sure Logging Enabled is ON in settings
2. Create a new ban
3. Check the shareban-logs channel
4. There should be a new message about the ban

Pass: Log message appeared  
Fail: No log

### Test 11.3 Test other logged actions

Do each of these and check if a log appears

- [ ] Unban someone should log
- [ ] Add a moderator should log
- [ ] Remove a moderator should log
- [ ] Change a setting should log

Pass: All actions logged  
Fail: Some actions missing from logs

### Test 11.4 Test missing log channel

1. Delete the shareban-logs channel
2. Create a new ban
3. The server owner should recieve a DM from the bot about the missing channel

Pass: Owner got a DM  
Fail: No notification

 

## Part 12: Collection Management

### Test 12.1 Edit collection name and description

1. Type `/collection-edit`
2. Change the name to Renamed Collection
3. Change the description
4. Save
5. Use `/collection-info` to verify

Pass: Name and description updated  
Fail: Old values still show

### Test 12.2 Invite Server C

1. Get Server Cs ID
2. Type `/collection-invite` with that ID
3. Go to Server C
4. Type `/collection-join`
5. This time turn ON sync existing bans
6. Accept the invite
7. Check if users you previously banned are now banned in Server C too

Pass: Server C joined and existing bans synced  
Fail: Join failed or bans didnt sync

### Test 12.3 Test the 50 server limit

This is hard to test fully but

1. Check if `/collection-info` shows server count
2. If you can somehow get close to 50 servers try adding a 51st

Pass: Limit is shown and enforced  
Fail: No indication of limit

 

## Part 13: Deleting Collections

Warning this will delete everything so only do this at the end of testing

### Test 13.1 Try to delete as non owner

This should fail

1. Go to Server B which is a member server not owner
2. Type `/collection-delete`
3. It should fail with a permission error

Pass: Delete blocked  
Fail: Non owner can delete which is a security issue

### Test 13.2 Delete the collection as owner

1. Go to Server A the owner
2. Type `/collection-delete`
3. There should be a confirmation step
4. Confirm the deletion
5. The collection should be gone

Pass: Collection deleted  
Fail: Still exists or error

### Test 13.3 Verify everything is cleaned up

1. In Server A and B and C try `/collection-info`
2. All should say your not in a collection
3. Try `/collection-create` it should work now

Pass: All servers are free again  
Fail: Servers still show as in collection

 

## Part 14: Edge Cases and Error Handling

These tests check how the bot handles mistakes and wierd situations

### Test 14.1 Try to ban the server owner

1. Try to `/shareban` the owner of one of the servers
2. This should fail because Discord doesnt allow banning server owners

Pass: Clear error message  
Fail: Bot crashes or gives confusing error

### Test 14.2 Try to ban someone not in the server

1. Get a user ID of someone who isnt in any of your test servers
2. Try to `/shareban` them
3. The bot should either handle this gracefully or still log it

Pass: Bot handles it without crashing  
Fail: Error or crash

### Test 14.3 Try to ban the bot itself

1. Get the bots user ID
2. Try to `/shareban` the bot

Pass: Bot refuses with a message  
Fail: Bot tries to ban itself

### Test 14.4 Enter an invalid user ID

1. Type `/shareban`
2. Enter something thats not a valid ID like notauser123
3. The bot should give a helpful error

Pass: Clear error message  
Fail: Confusing error or crash

### Test 14.5 Try commands in a server not in a collection

1. Go to a server that hasnt joined any collection
2. Try `/shareban`
3. It should say your not in a collection

Pass: Helpful error message  
Fail: Confusing error

### Test 14.6 Use commands without permission

1. Use an account that is NOT a mod and NOT the owner
2. Try `/shareban`
3. It should be denied with a clear message

Pass: Permission denied message  
Fail: Regular user can ban people which is a security issue

 

## Part 15: Lookup and Search Features

### Test 15.1 Search by moderator

1. Create a few bans with different moderator accounts if you have them
2. Type `/lookup-shareban`
3. Set the moderator filter to one specific person
4. Only their bans should appear

Pass: Results filtered correctly  
Fail: Wrong results or no filter working

### Test 15.2 Search by date

1. Type `/lookup-shareban`
2. Set a date filter to today
3. Only todays bans should appear

Pass: Date filter works  
Fail: Wrong dates shown

### Test 15.3 Search by username

This is a fuzzy search

1. Type `/lookup-shareban`
2. Type part of a banned users name
3. It should find matching bans

Pass: Found results with partial name  
Fail: No results or wrong matches

### Test 15.4 Combine filters

1. Try using date and user together
2. Results should match BOTH criteria

Pass: Combined filters work  
Fail: Filters dont combine properly

 

## Bug Report Template

When you find an issue write it down like this

```
BUG: Short description

Steps to Reproduce:
1. What you did first
2. What you did next
3. etc

Expected: What should have happened
Actual: What actually happened

Server: Which server you were in
Error Message if any: Copy the exact error
```

 

Thanks for testing. 
