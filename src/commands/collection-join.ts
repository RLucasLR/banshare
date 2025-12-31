import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { Collection, Invite, RecordNotFoundError, Server } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

@ApplyOptions<Command.Options>({
	description: 'Join a collection you have been invited to'
})
export class CollectionJoinCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-join',
			description: this.description,
			contexts: [InteractionContextType.Guild]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.')],
				ephemeral: true
			});
			return;
		}

		console.log(`[CMD] /collection-join initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// check perms
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to join a collection.')],
				ephemeral: true
			});
			return;
		}

		// check if already in a collection
		try {
			const existingServer = Server.getByGuildId(interaction.guildId);
			const existingCollection = Collection.getById(existingServer.collectionId);
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						`This server is already in the collection **${existingCollection.name}**. You must leave your current collection before joining a new one.`
					)
				],
				ephemeral: true
			});
			return;
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
			// not in collection, continue
		}

		// check for pending invites
		const pendingInvites = Invite.listPendingForGuild(interaction.guildId);
		if (pendingInvites.length === 0) {
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						'There are no pending invites for this server. Ask a collection owner to send you an invite using `/collection-invite`.'
					)
				],
				ephemeral: true
			});
			return;
		}

		// if only 1 show it, else let them choose
		if (pendingInvites.length === 1) {
			await this.showInviteConfirmation(interaction, pendingInvites[0]);
		} else {
			await this.showInviteList(interaction, pendingInvites);
		}
	}

	private async showInviteList(interaction: Command.ChatInputCommandInteraction, invites: Invite[]): Promise<void> {
		// build invite list
		const inviteDescriptions: string[] = [];
		const buttons: ButtonBuilder[] = [];

		for (let i = 0; i < Math.min(invites.length, 5); i++) {
			const invite = invites[i];
			let collectionName = 'Unknown Collection';
			try {
				const collection = Collection.getById(invite.collectionId);
				collectionName = collection.name;
			} catch {
				// collection might be deleted
			}

			const expiresAtUnix = Math.floor(new Date(invite.expiresAt).getTime() / 1000);
			inviteDescriptions.push(`**${i + 1}.** \`${collectionName}\`\n   Invited by: <@${invite.invitedBy}> • Expires: <t:${expiresAtUnix}:R>`);

			buttons.push(
				new ButtonBuilder()
					.setCustomId(`collection-join:select:${invite.id}`)
					.setLabel(`${i + 1}. ${collectionName.substring(0, 20)}`)
					.setStyle(ButtonStyle.Primary)
			);
		}

		const embed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Pending Collection Invites')
			.setDescription(`You have **${invites.length}** pending invite(s). Select one to join:\n\n` + inviteDescriptions.join('\n\n'))
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		// split buttons into rows (max 5)
		const rows: ActionRowBuilder<ButtonBuilder>[] = [];
		for (let i = 0; i < buttons.length; i += 5) {
			rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
		}

		// cancel button
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('collection-join:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			)
		);

		const response = await interaction.reply({
			embeds: [embed],
			components: rows,
			ephemeral: true,
			fetchReply: true
		});

		const collector = response.createMessageComponentCollector({
			time: 60_000
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			if (i.customId === 'collection-join:cancel') {
				collector.stop('cancelled');
				await i.deferUpdate();
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setColor(WARNING_COLOR)
							.setTitle('Cancelled')
							.setDescription('No collection was joined.')
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
				return;
			}

			if (i.customId.startsWith('collection-join:select:')) {
				const inviteId = i.customId.replace('collection-join:select:', '');
				const selectedInvite = invites.find((inv) => inv.id === inviteId);
				if (selectedInvite) {
					collector.stop('selected');
					await i.deferUpdate();
					// Show the confirmation flow with sync toggle
					await this.showInviteConfirmationAfterSelection(interaction, selectedInvite);
				}
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async showInviteConfirmationAfterSelection(interaction: Command.ChatInputCommandInteraction, invite: Invite): Promise<void> {
		let collection: Collection;
		try {
			collection = Collection.getById(invite.collectionId);
		} catch {
			await interaction.editReply({
				embeds: [this.errorEmbed('This invite is for a collection that no longer exists.')],
				components: []
			});
			return;
		}

		const expiresAtUnix = Math.floor(new Date(invite.expiresAt).getTime() / 1000);

		// try get inviter
		const inviter = await this.container.client.users.fetch(invite.invitedBy).catch(() => null);
		const inviterDisplay = inviter ? `${inviter.username} (<@${inviter.id}>)` : `<@${invite.invitedBy}>`;

		// try get owner guild
		const ownerGuild = await this.container.client.guilds.fetch(collection.mainGuildId).catch(() => null);
		const ownerGuildDisplay = ownerGuild ? ownerGuild.name : `\`${collection.mainGuildId}\``;

		// sync toggle
		let syncOnJoin = true;

		const buildEmbed = (sync: boolean) =>
			new EmbedBuilder()
				.setColor(EMBED_COLOR)
				.setTitle('Join Collection?')
				.setDescription(
					`You have been invited to join a BanShare collection.\n\n` +
						`**Collection:** \`${collection.name}\`\n` +
						`**Owner Server:** ${ownerGuildDisplay}\n` +
						`**Invited by:** ${inviterDisplay}\n` +
						`**Expires:** <t:${expiresAtUnix}:F> (<t:${expiresAtUnix}:R>)`
				)
				.addFields(
					{
						name: '⚠️ What This Means',
						value:
							"• Your server will sync with the collection's ban list\n" +
							'• Collection moderators can issue bans that affect your server\n' +
							'• You can leave the collection at any time',
						inline: false
					},
					{
						name: '🔄 Sync on Join',
						value: sync
							? '`Enabled` - All existing bans in the collection will be applied to your server when you join.'
							: '`Disabled` - Only new bans will be applied. Existing collection bans will not be synced.',
						inline: false
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

		const buildButtons = (sync: boolean) => [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId('collection-join:toggle-sync-selected')
					.setLabel(sync ? 'Sync on Join: ON' : 'Sync on Join: OFF')
					.setStyle(sync ? ButtonStyle.Success : ButtonStyle.Secondary)
					.setEmoji('🔄')
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`collection-join:confirm-selected:${invite.id}`)
					.setLabel('Join Collection')
					.setStyle(ButtonStyle.Success)
					.setEmoji('✅'),
				new ButtonBuilder().setCustomId('collection-join:decline-selected').setLabel('Decline').setStyle(ButtonStyle.Danger)
			)
		];

		const response = await interaction.editReply({
			embeds: [buildEmbed(syncOnJoin)],
			components: buildButtons(syncOnJoin)
		});

		const collector = response.createMessageComponentCollector({
			time: 60_000
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			if (i.customId === 'collection-join:toggle-sync-selected') {
				syncOnJoin = !syncOnJoin;
				await i.update({
					embeds: [buildEmbed(syncOnJoin)],
					components: buildButtons(syncOnJoin)
				});
				return;
			}

			if (i.customId === 'collection-join:decline-selected') {
				collector.stop('declined');
				await i.deferUpdate();
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setColor(WARNING_COLOR)
							.setTitle('Invite Declined')
							.setDescription(
								'You have declined the invite. The invite is still pending and you can join later if you change your mind.'
							)
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
				return;
			}

			if (i.customId.startsWith('collection-join:confirm-selected:')) {
				collector.stop('confirmed');
				await i.deferUpdate();
				await this.acceptInvite(interaction, invite, syncOnJoin);
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async showInviteConfirmation(interaction: Command.ChatInputCommandInteraction, invite: Invite): Promise<void> {
		let collection: Collection;
		try {
			collection = Collection.getById(invite.collectionId);
		} catch {
			await interaction.reply({
				embeds: [this.errorEmbed('This invite is for a collection that no longer exists.')],
				ephemeral: true
			});
			return;
		}

		const expiresAtUnix = Math.floor(new Date(invite.expiresAt).getTime() / 1000);

		// try get inviter
		const inviter = await this.container.client.users.fetch(invite.invitedBy).catch(() => null);
		const inviterDisplay = inviter ? `${inviter.username} (<@${inviter.id}>)` : `<@${invite.invitedBy}>`;

		// try get owner guild
		const ownerGuild = await this.container.client.guilds.fetch(collection.mainGuildId).catch(() => null);
		const ownerGuildDisplay = ownerGuild ? ownerGuild.name : `\`${collection.mainGuildId}\``;

		// sync toggle
		let syncOnJoin = true;

		const buildEmbed = (sync: boolean) =>
			new EmbedBuilder()
				.setColor(EMBED_COLOR)
				.setTitle('Join Collection?')
				.setDescription(
					`You have been invited to join a BanShare collection.\n\n` +
						`**Collection:** \`${collection.name}\`\n` +
						`**Owner Server:** ${ownerGuildDisplay}\n` +
						`**Invited by:** ${inviterDisplay}\n` +
						`**Expires:** <t:${expiresAtUnix}:F> (<t:${expiresAtUnix}:R>)`
				)
				.addFields(
					{
						name: '⚠️ What This Means',
						value:
							"• Your server will sync with the collection's ban list\n" +
							'• Collection moderators can issue bans that affect your server\n' +
							'• You can leave the collection at any time',
						inline: false
					},
					{
						name: '🔄 Sync on Join',
						value: sync
							? '`Enabled` - All existing bans in the collection will be applied to your server when you join.'
							: '`Disabled` - Only new bans will be applied. Existing collection bans will not be synced.',
						inline: false
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

		const buildButtons = (sync: boolean) => [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId('collection-join:toggle-sync')
					.setLabel(sync ? 'Sync on Join: ON' : 'Sync on Join: OFF')
					.setStyle(sync ? ButtonStyle.Success : ButtonStyle.Secondary)
					.setEmoji('🔄')
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`collection-join:confirm:${invite.id}`)
					.setLabel('Join Collection')
					.setStyle(ButtonStyle.Success)
					.setEmoji('✅'),
				new ButtonBuilder().setCustomId('collection-join:decline').setLabel('Decline').setStyle(ButtonStyle.Danger)
			)
		];

		const response = await interaction.reply({
			embeds: [buildEmbed(syncOnJoin)],
			components: buildButtons(syncOnJoin),
			ephemeral: true,
			fetchReply: true
		});

		const collector = response.createMessageComponentCollector({
			time: 60_000
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			if (i.customId === 'collection-join:toggle-sync') {
				syncOnJoin = !syncOnJoin;
				await i.update({
					embeds: [buildEmbed(syncOnJoin)],
					components: buildButtons(syncOnJoin)
				});
				return;
			}

			if (i.customId === 'collection-join:decline') {
				collector.stop('declined');
				await i.deferUpdate();
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setColor(WARNING_COLOR)
							.setTitle('Invite Declined')
							.setDescription(
								'You have declined the invite. The invite is still pending and you can join later if you change your mind.'
							)
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
				return;
			}

			if (i.customId.startsWith('collection-join:confirm:')) {
				collector.stop('confirmed');
				await i.deferUpdate();
				await this.acceptInvite(interaction, invite, syncOnJoin);
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async acceptInvite(interaction: Command.ChatInputCommandInteraction, invite: Invite, syncOnJoin: boolean = true): Promise<void> {
		// recheck invite is still valid
		invite.reload();
		if (invite.status !== 'pending' || invite.isExpired()) {
			await interaction.editReply({
				embeds: [this.errorEmbed('This invite is no longer valid. It may have expired or been cancelled.')],
				components: []
			});
			return;
		}

		// recheck server not in collection
		try {
			Server.getByGuildId(interaction.guildId!);
			await interaction.editReply({
				embeds: [this.errorEmbed('This server has already joined a collection.')],
				components: []
			});
			return;
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
		}

		// get collection
		let collection: Collection;
		try {
			collection = Collection.getById(invite.collectionId);
		} catch {
			await interaction.editReply({
				embeds: [this.errorEmbed('This collection no longer exists.')],
				components: []
			});
			return;
		}

		// check max linked servers
		const currentServers = Server.listByCollection(collection.id);
		if (currentServers.length >= collection.maxLinkedServers) {
			await interaction.editReply({
				embeds: [this.errorEmbed(`This collection has reached its maximum of \`${collection.maxLinkedServers}\` linked servers.`)],
				components: []
			});
			return;
		}

		// add server
		const server = Server.add({
			guildId: interaction.guildId!,
			collectionId: collection.id,
			addedBy: interaction.user.id,
			syncOnJoin
		});

		// mark accepted
		invite.accept();

		console.log(`[CMD] /collection-join: Server guildId=${interaction.guildId} joined collectionId=${collection.id} syncOnJoin=${syncOnJoin}`);

		// audit
		logAction({
			collectionId: collection.id,
			action: 'server.add',
			performedBy: interaction.user.id,
			details: {
				guildId: interaction.guildId,
				serverId: server.id,
				syncOnJoin: syncOnJoin,
				inviteId: invite.id
			}
		});

		logAction({
			collectionId: collection.id,
			action: 'invite.accept',
			performedBy: interaction.user.id,
			details: {
				inviteId: invite.id,
				guildId: interaction.guildId
			}
		});

		// success embed
		const successEmbed = new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('🎉 Successfully Joined Collection!')
			.setDescription(`Your server has joined the collection **${collection.name}**!`)
			.addFields(
				{
					name: 'Collection',
					value: `\`${collection.name}\``,
					inline: true
				},
				{
					name: 'Server ID',
					value: `\`${server.id}\``,
					inline: true
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		await interaction.editReply({
			embeds: [successEmbed],
			components: []
		});

		// send dm notifs
		await this.sendJoinNotifications(interaction, invite, collection);
	}

	private async sendJoinNotifications(interaction: Command.ChatInputCommandInteraction, invite: Invite, collection: Collection): Promise<void> {
		const joinedGuild = interaction.guild!;

		const notificationEmbed = new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('🎉 Server Joined Your Collection!')
			.setDescription(`**${joinedGuild.name}** has joined the collection **${collection.name}**!`)
			.addFields(
				{
					name: 'Server',
					value: `${joinedGuild.name} (\`${joinedGuild.id}\`)`,
					inline: false
				},
				{
					name: 'Accepted by',
					value: `<@${interaction.user.id}>`,
					inline: true
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		// dm inviter
		try {
			const inviter = await this.container.client.users.fetch(invite.invitedBy);
			await inviter.send({ embeds: [notificationEmbed] });
		} catch {
			console.log(`[CMD] /collection-join: Could not DM inviter userId=${invite.invitedBy}`);
		}

		// dm owner (if not inviter)
		try {
			const ownerGuild = await this.container.client.guilds.fetch(collection.mainGuildId);
			const owner = await ownerGuild.fetchOwner();
			// only dm if not inviter (avoid dupe)
			if (owner.id !== invite.invitedBy) {
				await owner.send({ embeds: [notificationEmbed] });
			}
		} catch {
			console.log(`[CMD] /collection-join: Could not DM collection owner`);
		}
	}

	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder().setColor(ERROR_COLOR).setTitle('Error').setDescription(message).setFooter({ text: FOOTER_CATEGORY }).setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Timed Out')
			.setDescription('This interaction has expired. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}
