import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, GuildMember, PermissionFlagsBits } from 'discord.js';
import { Collection as BanCollection } from '../database/models/collection';
import { Ban } from '../database/models/ban';
import { Server } from '../database/models/server';
import { Moderator } from '../database/models/moderator';
import { AuditLog } from '../database/models/auditLog';

// embed constants
const FOOTER_CATEGORY = 'BanShare • Bans';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

const ITEMS_PER_PAGE = 5;
const PAGINATION_TIMEOUT = 300000; // 5 minutes

interface SearchResult {
	type: 'ban' | 'action';
	timestamp: string;
	data: Ban | AuditLog;
}

@ApplyOptions<Command.Options>({
	description: 'Look up all audit logs and activity for a user (bans, moderator actions, etc.)'
})
export class LookupShareBanCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('lookup-shareban')
				.setDescription(this.description)
				.addStringOption((option) => option.setName('userid').setDescription('User ID to search for (all activity)').setRequired(false))
				.addStringOption((option) => option.setName('username').setDescription('Username to search for (all activity)').setRequired(false))
				.addUserOption((option) => option.setName('user').setDescription('User to search for (all activity)').setRequired(false))
				.addStringOption((option) =>
					option.setName('date').setDescription('Filter by date (YYYY-MM-DD) - can combine with any search option').setRequired(false)
				)
				.setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		if (!interaction.guild) {
			return interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.', 'Server required')],
				ephemeral: true
			});
		}

		const userId = interaction.options.getString('userid');
		const username = interaction.options.getString('username');
		const user = interaction.options.getUser('user');
		const dateStr = interaction.options.getString('date');

		const executorId = interaction.user.id;

		console.log(
			`[CMD] /lookup-shareban initiated by userId=${executorId} in guildId=${interaction.guildId} userId=${userId} username=${username} user=${user?.id} date=${dateStr}`
		);

		// only one search option (date can combine)
		const providedOptions = [userId, username, user].filter((opt) => opt !== null);
		if (providedOptions.length === 0) {
			return interaction.reply({
				embeds: [
					this.errorEmbed(
						'You must provide exactly one search option: `userid`, `username`, or `user`. You can optionally add `date` to filter results.',
						'No search criteria'
					)
				],
				ephemeral: true
			});
		}

		if (providedOptions.length > 1) {
			return interaction.reply({
				embeds: [
					this.errorEmbed(
						'You can only provide one search option at a time (userid, username, or user). The `date` filter can be combined with any of these.',
						'Multiple search criteria'
					)
				],
				ephemeral: true
			});
		}

		// parse date if given
		let filterDate: Date | null = null;
		if (dateStr) {
			const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
			if (!dateMatch) {
				return interaction.reply({
					embeds: [this.errorEmbed('Invalid date format. Please use `YYYY-MM-DD` format (e.g., `2025-12-31`).', 'Invalid date')],
					ephemeral: true
				});
			}
			const year = parseInt(dateMatch[1]);
			const month = parseInt(dateMatch[2]) - 1; // js months 0-indexed
			const day = parseInt(dateMatch[3]);
			filterDate = new Date(year, month, day);

			// check its a real date
			if (isNaN(filterDate.getTime()) || month < 0 || month > 11 || day < 1 || day > 31) {
				return interaction.reply({
					embeds: [this.errorEmbed('Invalid date. Please ensure the date is valid (e.g., `2025-12-31`).', 'Invalid date')],
					ephemeral: true
				});
			}
		}

		// get collection for this server
		let collection: BanCollection | null = null;

		// check if main guild first
		try {
			collection = BanCollection.getByMainGuildId(interaction.guild.id);
		} catch {
			// not main, check servers
		}

		// check linked server
		if (!collection) {
			let server: Server | null = null;
			try {
				server = Server.getByGuildId(interaction.guild.id);
			} catch {
				// not found
			}

			if (!server || !server.enabled) {
				return interaction.reply({
					embeds: [this.errorEmbed('This server is not part of any ban sharing collection, or is not enabled.', 'No collection')],
					ephemeral: true
				});
			}
			try {
				collection = BanCollection.getById(server.collectionId);
			} catch {
				// not found
			}
		}

		if (!collection) {
			return interaction.reply({
				embeds: [this.errorEmbed('Could not find the collection for this server.', 'Collection not found')],
				ephemeral: true
			});
		}

		// check if mod
		const member = interaction.member as GuildMember;
		const isMod = await this.isUserModerator(member, collection.id);
		const isOwner = collection.mainGuildId === interaction.guild.id && interaction.guild.ownerId === executorId;

		if (!isMod && !isOwner) {
			return interaction.reply({
				embeds: [
					this.errorEmbed('You must be a moderator or owner of this collection to look up audit logs and activity.', 'Permission denied')
				],
				ephemeral: true
			});
		}

		// do the search
		await interaction.deferReply({ ephemeral: true });

		let searchUserId: string | null = null;
		let searchUsername: string | null = null;

		if (user) {
			searchUserId = user.id;
		} else if (userId) {
			searchUserId = userId;
		} else if (username) {
			searchUsername = username;
		}

		const results = await this.performSearch(collection.id, searchUserId, searchUsername, filterDate, interaction);

		if (results.length === 0) {
			console.log(`[CMD] /lookup-shareban: NO RESULTS for userId=${executorId} search=${searchUserId || searchUsername}`);
			return interaction.editReply({
				embeds: [
					new EmbedBuilder()
						.setColor(WARNING_COLOR)
						.setTitle('No Results Found')
						.setDescription(
							searchUserId
								? `No activity found for user \`${searchUserId}\` in this collection.`
								: `No activity found for username containing \`${searchUsername}\` in this collection.`
						)
						.setFooter({ text: FOOTER_CATEGORY })
						.setTimestamp()
				]
			});
		}

		console.log(`[CMD] /lookup-shareban: FOUND ${results.length} results for userId=${executorId}`);

		// audit log
		AuditLog.create({
			collectionId: collection.id,
			action: 'ban.lookup',
			performedBy: executorId,
			details: {
				searchType: searchUserId ? 'userId' : 'username',
				searchValue: searchUserId || searchUsername,
				filterDate: filterDate ? filterDate.toISOString().split('T')[0] : null,
				resultCount: results.length,
				guildId: interaction.guild.id
			}
		});

		// show paginated results
		await this.showPaginatedResults(interaction, collection, results, searchUserId, searchUsername);
		return;
	}

	private async isUserModerator(member: GuildMember, collectionId: string): Promise<boolean> {
		const moderators = Moderator.listByCollection(collectionId);

		for (const mod of moderators) {
			if (mod.type === 'user' && mod.value === member.id) {
				return true;
			}
			if (mod.type === 'role' && member.roles.cache.has(mod.value)) {
				return true;
			}
		}

		return false;
	}

	private async performSearch(
		collectionId: string,
		userId: string | null,
		username: string | null,
		filterDate: Date | null,
		interaction: Command.ChatInputCommandInteraction
	): Promise<SearchResult[]> {
		const results: SearchResult[] = [];

		if (userId) {
			// search bans where user is target
			const bans = Ban.listByCollection(collectionId, false).filter((ban) => {
				if (ban.userId !== userId) return false;
				if (filterDate) {
					const banDate = new Date(ban.timestamp);
					// same day?
					return banDate.toDateString() === filterDate.toDateString();
				}
				return true;
			});

			for (const ban of bans) {
				results.push({
					type: 'ban',
					timestamp: ban.timestamp,
					data: ban
				});
			}

			// search logs where user is performer
			const auditLogs = AuditLog.listByCollection(collectionId, 1000).filter((log) => {
				if (log.performedBy !== userId) return false;
				if (filterDate) {
					const logDate = new Date(log.performedAt);
					// same day?
					return logDate.toDateString() === filterDate.toDateString();
				}
				return true;
			});

			for (const log of auditLogs) {
				results.push({
					type: 'action',
					timestamp: log.performedAt,
					data: log
				});
			}
		} else if (username) {
			// search by username
			const allBans = Ban.listByCollection(collectionId, false).filter((ban) => {
				if (!filterDate) return true;
				const banDate = new Date(ban.timestamp);
				return banDate.toDateString() === filterDate.toDateString();
			});

			for (const ban of allBans) {
				try {
					const user = await interaction.client.users.fetch(ban.userId);
					if (user.username.toLowerCase().includes(username.toLowerCase()) || user.tag.toLowerCase().includes(username.toLowerCase())) {
						results.push({
							type: 'ban',
							timestamp: ban.timestamp,
							data: ban
						});
					}
				} catch {
					// not found
				}
			}

			// search logs by username
			const auditLogs = AuditLog.listByCollection(collectionId, 1000).filter((log) => {
				if (!filterDate) return true;
				const logDate = new Date(log.performedAt);
				return logDate.toDateString() === filterDate.toDateString();
			});

			for (const log of auditLogs) {
				try {
					const user = await interaction.client.users.fetch(log.performedBy);
					if (user.username.toLowerCase().includes(username.toLowerCase()) || user.tag.toLowerCase().includes(username.toLowerCase())) {
						results.push({
							type: 'action',
							timestamp: log.performedAt,
							data: log
						});
					}
				} catch {
					// not found
				}
			}
		}

		// sort by time desc
		results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		return results;
	}

	private async showPaginatedResults(
		interaction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		results: SearchResult[],
		searchUserId: string | null,
		searchUsername: string | null
	) {
		let currentPage = 0;
		const totalPages = Math.ceil(results.length / ITEMS_PER_PAGE);

		const buildEmbed = async (page: number): Promise<EmbedBuilder> => {
			const start = page * ITEMS_PER_PAGE;
			const end = Math.min(start + ITEMS_PER_PAGE, results.length);
			const pageResults = results.slice(start, end);

			const embed = new EmbedBuilder()
				.setColor(EMBED_COLOR)
				.setTitle('Audit Log & Activity Lookup')
				.setDescription(
					searchUserId ? `All activity for user \`${searchUserId}\`` : `All activity for username containing \`${searchUsername}\``
				)
				.addFields({
					name: 'Collection',
					value: `\`${collection.name}\` (\`${collection.id}\`)`,
					inline: false
				})
				.setFooter({
					text: `${FOOTER_CATEGORY} • Page ${page + 1}/${totalPages} • ${results.length} total results`
				})
				.setTimestamp();

			// add results as fields
			for (let i = 0; i < pageResults.length; i++) {
				const result = pageResults[i];
				const globalIndex = start + i + 1;

				if (result.type === 'ban') {
					const ban = result.data as Ban;

					// try resolve user
					let userTag = `User \`${ban.userId}\``;
					try {
						const user = await interaction.client.users.fetch(ban.userId);
						userTag = `**${user.tag}**`;
					} catch {
						// not found
					}

					// try resolve mod
					let modTag = `Moderator \`${ban.moderatorId}\``;
					try {
						const mod = await interaction.client.users.fetch(ban.moderatorId);
						modTag = `${mod.tag}`;
					} catch {
						// not found
					}

					const statusEmoji = ban.active ? '🔴' : '⚪';
					const timestamp = `<t:${Math.floor(new Date(ban.timestamp).getTime() / 1000)}:R>`;

					embed.addFields({
						name: `${globalIndex}. ${statusEmoji} Ban Record`,
						value:
							`**Target:** ${userTag}\n` +
							`**By:** ${modTag}\n` +
							`**Reason:** ${ban.reason ? `\`${ban.reason.slice(0, 100)}${ban.reason.length > 100 ? '...' : ''}\`` : '*No reason*'}\n` +
							`**Status:** ${ban.active ? '`Active`' : '`Inactive`'}\n` +
							`**Ban ID:** \`${ban.id}\`\n` +
							`**When:** ${timestamp}`,
						inline: false
					});
				} else {
					const log = result.data as AuditLog;

					// try resolve performer
					let performerTag = `User \`${log.performedBy}\``;
					try {
						const user = await interaction.client.users.fetch(log.performedBy);
						performerTag = `**${user.tag}**`;
					} catch {
						// not found
					}

					const actionEmoji = this.getActionEmoji(log.action);
					const timestamp = `<t:${Math.floor(new Date(log.performedAt).getTime() / 1000)}:R>`;

					// format details
					let detailsStr = '';
					if (log.details && typeof log.details === 'object') {
						const details = log.details as Record<string, unknown>;
						const keys = Object.keys(details).slice(0, 3); // first 3
						detailsStr = keys.map((key) => `${key}: \`${String(details[key]).slice(0, 50)}\``).join(', ');
						if (Object.keys(details).length > 3) {
							detailsStr += '...';
						}
					}

					embed.addFields({
						name: `${globalIndex}. ${actionEmoji} Moderator Action`,
						value:
							`**Performer:** ${performerTag}\n` +
							`**Action:** \`${log.action}\`\n` +
							(detailsStr ? `**Details:** ${detailsStr}\n` : '') +
							`**Log ID:** \`${log.id}\`\n` +
							`**When:** ${timestamp}`,
						inline: false
					});
				}
			}

			return embed;
		};

		const buildButtons = (page: number): ActionRowBuilder<ButtonBuilder> => {
			return new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId('lookup:prev')
					.setLabel('Previous')
					.setStyle(ButtonStyle.Primary)
					.setEmoji('◀️')
					.setDisabled(page === 0),
				new ButtonBuilder()
					.setCustomId('lookup:next')
					.setLabel('Next')
					.setStyle(ButtonStyle.Primary)
					.setEmoji('▶️')
					.setDisabled(page === totalPages - 1),
				new ButtonBuilder().setCustomId('lookup:close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
			);
		};

		const embed = await buildEmbed(currentPage);
		const components = [buildButtons(currentPage)];

		const message = await interaction.editReply({
			embeds: [embed],
			components
		});

		if (totalPages === 1) {
			// single page, just close button
			const collector = message.createMessageComponentCollector({
				componentType: ComponentType.Button,
				time: PAGINATION_TIMEOUT
			});

			collector.on('collect', async (i) => {
				if (i.user.id !== interaction.user.id) {
					await i.reply({
						embeds: [this.errorEmbed('This interaction is not for you.', 'Interaction denied')],
						ephemeral: true
					});
					return;
				}

				if (i.customId === 'lookup:close') {
					console.log(`[CMD] /lookup-shareban: CLOSED by userId=${interaction.user.id}`);
					collector.stop('closed');
					await i.update({
						embeds: [
							new EmbedBuilder()
								.setColor(SUCCESS_COLOR)
								.setTitle('Lookup Closed')
								.setDescription('The lookup has been closed.')
								.setFooter({ text: FOOTER_CATEGORY })
								.setTimestamp()
						],
						components: []
					});
				}
			});

			collector.on('end', async (_, reason) => {
				if (reason === 'time') {
					console.log(`[CMD] /lookup-shareban: TIMED OUT for userId=${interaction.user.id}`);
					try {
						await interaction.editReply({
							embeds: [this.timeoutEmbed()],
							components: []
						});
					} catch {
						// deleted maybe
					}
				}
			});

			return;
		}

		// multi page
		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: PAGINATION_TIMEOUT
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.', 'Interaction denied')],
					ephemeral: true
				});
				return;
			}

			if (i.customId === 'lookup:prev') {
				currentPage = Math.max(0, currentPage - 1);
				const newEmbed = await buildEmbed(currentPage);
				const newComponents = [buildButtons(currentPage)];
				await i.update({
					embeds: [newEmbed],
					components: newComponents
				});
			} else if (i.customId === 'lookup:next') {
				currentPage = Math.min(totalPages - 1, currentPage + 1);
				const newEmbed = await buildEmbed(currentPage);
				const newComponents = [buildButtons(currentPage)];
				await i.update({
					embeds: [newEmbed],
					components: newComponents
				});
			} else if (i.customId === 'lookup:close') {
				console.log(`[CMD] /lookup-shareban: CLOSED by userId=${interaction.user.id} at page ${currentPage + 1}`);
				collector.stop('closed');
				await i.update({
					embeds: [
						new EmbedBuilder()
							.setColor(SUCCESS_COLOR)
							.setTitle('Lookup Closed')
							.setDescription('The lookup has been closed.')
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /lookup-shareban: TIMED OUT for userId=${interaction.user.id} at page ${currentPage + 1}`);
				try {
					await interaction.editReply({
						embeds: [this.timeoutEmbed()],
						components: []
					});
				} catch {
					// deleted maybe
				}
			}
		});
	}

	private getActionEmoji(action: string): string {
		if (action.includes('ban.create')) return '🔨';
		if (action.includes('ban.revoke')) return '✅';
		if (action.includes('ban.edit')) return '✏️';
		if (action.includes('ban.sync')) return '🔄';
		if (action.includes('ban.lookup')) return '🔍';
		if (action.includes('moderator.add')) return '➕';
		if (action.includes('moderator.remove')) return '➖';
		if (action.includes('server.add')) return '🌐';
		if (action.includes('server.remove')) return '🚫';
		if (action.includes('collection.create')) return '📁';
		if (action.includes('collection.delete')) return '🗑️';
		if (action.includes('invite')) return '📨';
		if (action.includes('setting')) return '⚙️';
		if (action.includes('evidence')) return '📎';
		if (action.includes('failed')) return '❌';
		return '📋';
	}

	// helper embeds
	private errorEmbed(message: string, title = 'Error'): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle(title.startsWith('Error:') ? title : `Error: ${title}`)
			.setDescription(message)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Timed Out')
			.setDescription('This lookup has expired. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}
