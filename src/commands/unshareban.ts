import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, User } from 'discord.js';
import { Collection as BanCollection } from '../database/models/collection';
import { Ban } from '../database/models/ban';
import { Server } from '../database/models/server';
import { Moderator } from '../database/models/moderator';
import { logAction } from '../lib/utils';

// embed constants
const FOOTER_CATEGORY = 'BanShare • Bans';
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

@ApplyOptions<Command.Options>({
	name: 'unshareban',
	description: 'Unban a user from a collection (revokes the ban)',
	preconditions: ['GuildOnly']
})
export class UnsharebanCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand(
			(builder) =>
				builder
					.setName('unshareban')
					.setDescription('Unban a user from a collection (revokes the ban)')
					.setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
					.addUserOption((option) => option.setName('user').setDescription('The Discord user to unban').setRequired(false))
					.addStringOption((option) =>
						option.setName('username').setDescription('Username to search for (closest match)').setRequired(false)
					)
					.addStringOption((option) => option.setName('userid').setDescription('The Discord user ID to unban').setRequired(false)),
			{ idHints: [] }
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		console.log(`[CMD] /unshareban initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		const userOption = interaction.options.getUser('user');
		const usernameOption = interaction.options.getString('username');
		const userIdOption = interaction.options.getString('userid');

		// count provided options
		const providedOptions = [userOption, usernameOption, userIdOption].filter((opt) => opt !== null);

		if (providedOptions.length === 0) {
			console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=No options provided`);
			await interaction.reply({
				embeds: [this.errorEmbed('You must provide exactly one of: `user`, `username`, or `userid`.')],
				ephemeral: true
			});
			return;
		}

		if (providedOptions.length > 1) {
			console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=Multiple options provided`);
			await interaction.reply({
				embeds: [this.errorEmbed('You can only provide one of: `user`, `username`, or `userid`. Please choose one.')],
				ephemeral: true
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		// resolve target user id
		let targetUserId: string | null = null;
		let targetUser: User | null = null;

		try {
			if (userOption) {
				targetUserId = userOption.id;
				targetUser = userOption;
			} else if (userIdOption) {
				// validate snowflake
				if (!/^\d{17,20}$/.test(userIdOption)) {
					console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=Invalid user ID format`);
					await interaction.editReply({
						embeds: [this.errorEmbed(`Invalid user ID format: \`${userIdOption}\`. Must be a valid Discord snowflake.`)]
					});
					return;
				}
				targetUserId = userIdOption;
				// try to fetch user
				try {
					targetUser = await this.container.client.users.fetch(userIdOption);
				} catch {
					// might not exist, continue with just id
					targetUser = null;
				}
			} else if (usernameOption) {
				// search by username in active bans (only from collections user has access to)
				const result = await this.findUserByUsername(usernameOption, interaction.guildId!, interaction.user.id);
				if (!result) {
					console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=No matching user found`);
					await interaction.editReply({
						embeds: [this.errorEmbed(`No banned user found matching username: \`${usernameOption}\` in collections you have access to.`)]
					});
					return;
				}
				targetUserId = result.userId;
				targetUser = result.user;
			}

			if (!targetUserId) {
				console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=Could not resolve user`);
				await interaction.editReply({
					embeds: [this.errorEmbed('Could not resolve the target user.')]
				});
				return;
			}

			// find active bans and filter by permission
			const guildId = interaction.guildId!;
			const allActiveBans = Ban.findByUserId(targetUserId, true);
			const bansUserCanUnban: Ban[] = [];

			for (const ban of allActiveBans) {
				try {
					const collection = BanCollection.getById(ban.collectionId);
					// owner or mod?
					const isOwner = collection.mainGuildId === guildId;
					const moderators = Moderator.listByCollection(collection.id);
					const isMod = moderators.some((m) => m.type === 'user' && m.value === interaction.user.id);
					if (isOwner || isMod) {
						bansUserCanUnban.push(ban);
					}
				} catch {
					// collection might not exist
					continue;
				}
			}

			if (bansUserCanUnban.length === 0) {
				console.log(`[CMD] /unshareban: FAILED userId=${interaction.user.id} error=No accessible bans for targetUserId=${targetUserId}`);
				await interaction.editReply({
					embeds: [
						this.errorEmbed(
							targetUser
								? `<@${targetUserId}> (\`${targetUserId}\`) is not banned in any collection you have access to.`
								: `User \`${targetUserId}\` is not banned in any collection you have access to.`
						)
					]
				});
				return;
			}

			// build confirm embed
			const confirmEmbed = await this.buildConfirmationEmbed(targetUserId, targetUser, bansUserCanUnban);
			const confirmButtons = this.buildConfirmationButtons();

			const reply = await interaction.editReply({
				embeds: [confirmEmbed],
				components: confirmButtons
			});

			// wait for response
			try {
				const buttonInteraction = await reply.awaitMessageComponent({
					filter: (i) => i.user.id === interaction.user.id,
					time: 60_000
				});

				if (buttonInteraction.customId === 'unshareban:cancel') {
					console.log(`[CMD] /unshareban: CANCELLED by userId=${interaction.user.id}`);
					await buttonInteraction.update({
						embeds: [this.cancelledEmbed()],
						components: []
					});
					return;
				}

				if (buttonInteraction.customId === 'unshareban:confirm') {
					await buttonInteraction.deferUpdate();

					// do the unban
					const result = await this.executeUnban(targetUserId, targetUser, bansUserCanUnban, interaction.user.id);

					console.log(
						`[CMD] /unshareban: COMPLETED userId=${interaction.user.id} targetUserId=${targetUserId} unbannedCount=${result.unbannedCount}`
					);

					await interaction.editReply({
						embeds: [result.embed],
						components: []
					});
				}
			} catch {
				// timeout
				console.log(`[CMD] /unshareban: TIMEOUT userId=${interaction.user.id}`);
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		} catch (error) {
			console.log(`[CMD] /unshareban: ERROR userId=${interaction.user.id} error=${error instanceof Error ? error.message : 'Unknown'}`);
			await interaction.editReply({
				embeds: [this.errorEmbed('An unexpected error occurred. Please try again.')]
			});
		}
	}

	private async findUserByUsername(username: string, guildId: string, userId: string): Promise<{ userId: string; user: User | null } | null> {
		// get bans only from collections the user has access to
		const accessibleBans = await this.getAccessibleActiveBans(guildId, userId);
		const uniqueUserIds = [...new Set(accessibleBans.map((b) => b.userId))].slice(0, 200);

		const searchLower = username.toLowerCase();
		let bestMatch: { userId: string; user: User; score: number } | null = null;

		for (const targetUserId of uniqueUserIds) {
			try {
				const user = await this.container.client.users.fetch(targetUserId);
				const usernameLower = user.username.toLowerCase();
				const displayNameLower = user.displayName?.toLowerCase() ?? '';

				// exact match
				if (usernameLower === searchLower || displayNameLower === searchLower) {
					return { userId: targetUserId, user };
				}

				// partial match scoring
				let score = 0;
				if (usernameLower.includes(searchLower)) {
					score = searchLower.length / usernameLower.length;
				} else if (displayNameLower.includes(searchLower)) {
					score = (searchLower.length / displayNameLower.length) * 0.9;
				} else if (usernameLower.startsWith(searchLower.slice(0, 3))) {
					score = 0.3;
				}

				if (score > 0 && (!bestMatch || score > bestMatch.score)) {
					bestMatch = { userId: targetUserId, user, score };
				}
			} catch {
				// cant fetch, skip
				continue;
			}
		}

		return bestMatch ? { userId: bestMatch.userId, user: bestMatch.user } : null;
	}

	private async getAccessibleActiveBans(guildId: string, executorUserId: string): Promise<Ban[]> {
		// first get all collections the user has access to from this guild
		const accessibleCollectionIds: string[] = [];

		// check if this guild owns a collection
		try {
			const ownedCollection = BanCollection.getByMainGuildId(guildId);
			accessibleCollectionIds.push(ownedCollection.id);
		} catch {
			// not owner, check if linked
		}

		// check if this guild is linked to a collection
		try {
			const server = Server.getByGuildId(guildId);
			if (server.enabled && !accessibleCollectionIds.includes(server.collectionId)) {
				accessibleCollectionIds.push(server.collectionId);
			}
		} catch {
			// not linked
		}

		if (accessibleCollectionIds.length === 0) {
			return [];
		}

		// now get active bans from these collections where user is a moderator
		const accessibleBans: Ban[] = [];

		for (const collectionId of accessibleCollectionIds) {
			try {
				const collection = BanCollection.getById(collectionId);
				// check if user is owner or mod
				const isOwner = collection.mainGuildId === guildId;
				const moderators = Moderator.listByCollection(collectionId);
				const isMod = moderators.some((m) => m.type === 'user' && m.value === executorUserId);

				if (isOwner || isMod) {
					const bans = Ban.listByCollection(collectionId, true);
					accessibleBans.push(...bans);
				}
			} catch {
				// collection not found
				continue;
			}
		}

		return accessibleBans;
	}

	private async buildConfirmationEmbed(targetUserId: string, targetUser: User | null, bans: Ban[]): Promise<EmbedBuilder> {
		const embed = new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('⚠️ Confirm Unban')
			.setDescription('Are you sure you want to unban this user?')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		// user info
		if (targetUser) {
			embed.setThumbnail(targetUser.displayAvatarURL({ size: 128 }));
			embed.addFields({
				name: 'User',
				value: `<@${targetUserId}> (\`${targetUser.tag}\`)\nID: \`${targetUserId}\``,
				inline: false
			});
		} else {
			embed.addFields({
				name: 'User',
				value: `User ID: \`${targetUserId}\`\n*(User not fetchable)*`,
				inline: false
			});
		}

		// collections affected
		const collectionNames: string[] = [];
		for (const ban of bans) {
			try {
				const collection = BanCollection.getById(ban.collectionId);
				collectionNames.push(`• **${collection.name}** (\`${collection.id}\`)`);
			} catch {
				collectionNames.push(`• *Unknown Collection* (\`${ban.collectionId}\`)`);
			}
		}

		embed.addFields({
			name: `Collections (${bans.length})`,
			value: collectionNames.join('\n').slice(0, 1024),
			inline: false
		});

		// warning
		embed.addFields({
			name: '⚠️ This will:',
			value:
				'• Mark the ban as **inactive** in the database\n' +
				'• Attempt to **unban** from all servers in the collection(s)\n' +
				'• Attempt to **DM** the user about the unban',
			inline: false
		});

		return embed;
	}

	private buildConfirmationButtons(): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('unshareban:confirm').setLabel('Confirm Unban').setStyle(ButtonStyle.Danger).setEmoji('✅'),
				new ButtonBuilder().setCustomId('unshareban:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
			)
		];
	}

	private async executeUnban(
		targetUserId: string,
		targetUser: User | null,
		bans: Ban[],
		executorId: string
	): Promise<{ embed: EmbedBuilder; unbannedCount: number }> {
		const results: { collection: string; servers: { guildId: string; success: boolean; error?: string }[] }[] = [];
		let totalUnbannedServers = 0;
		let totalFailedServers = 0;
		let dmSent = false;

		// process each ban
		for (const ban of bans) {
			try {
				const collection = BanCollection.getById(ban.collectionId);
				const serverResults: { guildId: string; success: boolean; error?: string }[] = [];

				// get all servers in collection (inc main)
				const servers = Server.listByCollection(collection.id);
				const allGuildIds = [collection.mainGuildId, ...servers.map((s) => s.guildId)];
				const uniqueGuildIds = [...new Set(allGuildIds)];

				// unban from each
				for (const guildId of uniqueGuildIds) {
					try {
						const guild = await this.container.client.guilds.fetch(guildId);
						await guild.members.unban(targetUserId, `Unshareban by <@${executorId}>`);
						serverResults.push({ guildId, success: true });
						totalUnbannedServers++;
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : 'Unknown error';
						serverResults.push({ guildId, success: false, error: errorMsg });
						totalFailedServers++;
					}
				}

				// mark as inactive
				ban.active = false;
				ban.save();

				// audit log
				const successfulServerIds = serverResults.filter((s) => s.success).map((s) => s.guildId);
				const failedServerIds = serverResults.filter((s) => !s.success).map((s) => s.guildId);

				logAction({
					collectionId: collection.id,
					action: 'ban.revoke',
					performedBy: executorId,
					details: {
						banId: ban.id,
						userId: targetUserId,
						serverIds: successfulServerIds,
						serverCount: successfulServerIds.length
					}
				});

				// log failures if any
				if (failedServerIds.length > 0) {
					logAction({
						collectionId: collection.id,
						action: 'ban.revoke.failed',
						performedBy: executorId,
						details: {
							banId: ban.id,
							userId: targetUserId,
							serverIds: failedServerIds,
							serverCount: failedServerIds.length,
							errors: serverResults.filter((s) => !s.success).map((s) => ({ guildId: s.guildId, error: s.error }))
						}
					});
				}

				results.push({ collection: collection.name, servers: serverResults });
			} catch (err) {
				console.log(`[CMD] /unshareban: Failed to process ban ${ban.id}: ${err instanceof Error ? err.message : 'Unknown'}`);
			}
		}

		// try to dm
		if (targetUser) {
			try {
				const collectionNames = bans
					.map((b) => {
						try {
							return BanCollection.getById(b.collectionId).name;
						} catch {
							return 'Unknown Collection';
						}
					})
					.join(', ');

				const dmEmbed = new EmbedBuilder()
					.setColor(SUCCESS_COLOR)
					.setTitle('🔓 You Have Been Unbanned')
					.setDescription(`You have been unbanned from the following collection(s):\n**${collectionNames}**`)
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp();

				await targetUser.send({ embeds: [dmEmbed] });
				dmSent = true;
			} catch {
				// dms closed
				dmSent = false;
			}
		}

		// build result embed
		const embed = new EmbedBuilder()
			.setColor(totalFailedServers === 0 ? SUCCESS_COLOR : WARNING_COLOR)
			.setTitle(totalFailedServers === 0 ? '✅ Unban Complete' : '⚠️ Unban Partially Complete')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		let description = targetUser
			? `<@${targetUserId}> (\`${targetUser.tag}\`) has been unbanned.`
			: `User \`${targetUserId}\` has been unbanned.`;

		description += `\n\n**Results:**`;
		description += `\n• Bans revoked: \`${bans.length}\``;
		description += `\n• Servers unbanned: \`${totalUnbannedServers}\``;
		if (totalFailedServers > 0) {
			description += `\n• Servers failed: \`${totalFailedServers}\``;
		}
		description += `\n• DM sent: ${dmSent ? '✅' : '❌'}`;

		embed.setDescription(description);

		// add collection details
		for (const result of results) {
			const successCount = result.servers.filter((s) => s.success).length;
			const failCount = result.servers.filter((s) => !s.success).length;

			let fieldValue = `Unbanned: \`${successCount}\``;
			if (failCount > 0) {
				fieldValue += ` | Failed: \`${failCount}\``;
			}

			embed.addFields({
				name: result.collection,
				value: fieldValue,
				inline: true
			});
		}

		return { embed, unbannedCount: totalUnbannedServers };
	}

	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('❌ Error')
			.setDescription(message)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private cancelledEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('Cancelled')
			.setDescription('The unban has been cancelled.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('⏱️ Timed Out')
			.setDescription('The confirmation timed out. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}
