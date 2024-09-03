import { SearchMode, Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "../../core/context.ts";
import { log_to_file } from "../../core/logger.ts";
import { embeddingZeroVector } from "../../core/memory.ts";
import {
  messageCompletionFooter,
  shouldRespondFooter,
} from "../../core/parsing.ts";
import { AgentRuntime } from "../../core/runtime.ts";
import settings from "../../core/settings.ts";
import {
  Content,
  HandlerCallback,
  Memory,
  State,
  UUID,
} from "../../core/types.ts";
import { ClientBase } from "./base.ts";
import {
  buildConversationThread,
  getRecentConversations,
  sendTweetChunks,
  wait,
} from "./utils.ts";
import { stringToUuid } from "../../core/uuid.ts";

export const messageHandlerTemplate =
  `{{relevantFacts}}
{{recentFacts}}

# Task: Generate a post for the character {{agentName}}.
About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}):
{{currentPost}}

` + messageCompletionFooter;

export const shouldRespondTemplate =
  `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE.

{{currentPost}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient extends ClientBase {
  onReady() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        Math.floor(Math.random() * 10000) + 10000,
      ); // Random interval between 10-15 minutes
    };
    handleTwitterInteractionsLoop();
  }

  private tweetCacheFilePath = "tweetcache/latest_checked_tweet_id.txt";

  constructor(runtime: AgentRuntime) {
    super({
      runtime,
    });

    try {
      if (fs.existsSync(this.tweetCacheFilePath)) {
        const data = fs.readFileSync(this.tweetCacheFilePath, "utf-8");
        this.lastCheckedTweetId = data.trim();
      } else {
        console.warn("Tweet cache file not found.");
      }
    } catch (error) {
      console.error("Error loading latest checked tweet ID from file:", error);
    }
  }

  async handleTwitterInteractions() {
    console.log("Checking Twitter interactions");
    try {
      // Check for mentions
      const tweetCandidates = (
        await this.fetchSearchTweets(
          `@${settings.TWITTER_USERNAME}`,
          20,
          SearchMode.Latest,
        )
      ).tweets;

      // de-duplicate tweetCandidates with a set
      const uniqueTweetCandidates = [...new Set(tweetCandidates)];

      // Sort tweet candidates by ID in ascending order
      uniqueTweetCandidates.sort((a, b) => a.id.localeCompare(b.id));

      // for each tweet candidate, handle the tweet
      for (const tweet of uniqueTweetCandidates) {
        if (!this.lastCheckedTweetId || tweet.id > this.lastCheckedTweetId) {
          if (tweet.userId === this.twitterUserId) {
            continue;
          }

          const conversationId = tweet.conversationId;

          const roomId = stringToUuid(conversationId);
          await this.runtime.ensureRoomExists(roomId);

          const userIdUUID = stringToUuid(tweet.userId as string);
          const agentId = this.runtime.agentId;

          await Promise.all([
            this.runtime.ensureUserExists(
              agentId,
              settings.TWITTER_USERNAME,
              this.runtime.character.name,
              "twitter",
            ),
            this.runtime.ensureUserExists(
              userIdUUID,
              tweet.username,
              tweet.name,
              "twitter",
            ),
          ]);

          await Promise.all([
            this.runtime.ensureParticipantInRoom(userIdUUID, roomId),
            this.runtime.ensureParticipantInRoom(agentId, roomId),
          ]);

          await buildConversationThread(tweet, this);

          const message = {
            content: { text: tweet.text },
            userId: userIdUUID,
            roomId,
          };

          await this.handleTweet({
            tweet,
            message,
          });

          // Update the last checked tweet ID after processing each tweet
          this.lastCheckedTweetId = tweet.id;

          try {
            fs.writeFileSync(
              this.tweetCacheFilePath,
              this.lastCheckedTweetId.toString(),
              "utf-8",
            );

          } catch (error) {
            console.error(
              "Error saving latest checked tweet ID to file:",
              error,
            );
          }
        }
      }

      // Save the latest checked tweet ID to the file
      try {
        fs.writeFileSync(
          this.tweetCacheFilePath,
          this.lastCheckedTweetId.toString(),
          "utf-8",
        );
      } catch (error) {
        console.error("Error saving latest checked tweet ID to file:", error);
      }

      console.log("Finished checking Twitter interactions");
    } catch (error) {
      console.error("Error handling Twitter interactions:", error);
    }
  }

  private async handleTweet({
    tweet,
    message,
  }: {
    tweet: Tweet;
    message: Memory;
  }) {
    if (tweet.username === settings.TWITTER_USERNAME) {
      console.log("skipping tweet from bot itself", tweet.id);
      // Skip processing if the tweet is from the bot itself
      return;
    }

    if (!message.content.text) {
      console.log("skipping tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }
    const formatTweet = (tweet: Tweet) => {
      return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
    };

    // Fetch recent conversations
    const recentConversationsText = await getRecentConversations(
      this.runtime,
      this,
      settings.TWITTER_USERNAME,
    );

    const currentPost = formatTweet(tweet);

    console.log("currentPost", currentPost);

    console.log("composeState");

    let state = await this.runtime.composeState(message, {
      twitterClient: this.twitterClient,
      twitterUserName: settings.TWITTER_USERNAME,
      recentConversations: recentConversationsText,
      currentPost,
    });

    // check if the tweet exists, save if it doesn't
    const tweetId = stringToUuid(tweet.id);
    const tweetExists =
      await this.runtime.messageManager.getMemoryById(tweetId);

    if (!tweetExists) {
      const userIdUUID = stringToUuid(tweet.userId as string);
      const roomId = stringToUuid(tweet.conversationId);

      const message = {
        id: tweetId,
        content: { text: tweet.text, url: tweet.permanentUrl, inReplyTo: tweet.inReplyToStatusId ? stringToUuid(tweet.inReplyToStatusId) : undefined },
        userId: userIdUUID,
        roomId,
        createdAt: new Date(tweet.timestamp),
      };
      this.saveRequestMessage(message, state);
    }

    console.log("composeState done");

    const shouldRespondContext = composeContext({
      state,
      template: shouldRespondTemplate,
    });

    console.log("shouldRespondContext");

    const shouldRespond = await this.runtime.shouldRespondCompletion({
      context: shouldRespondContext,
      stop: [],
      model: this.runtime.model,
    });

    if (!shouldRespond) {
      console.log("Not responding to message");
      return { text: "", action: "IGNORE" };
    }

    const context = composeContext({
      state,
      template: messageHandlerTemplate,
    });

    const datestr = new Date().toISOString().replace(/:/g, "-");

    // log context to file
    log_to_file(
      `${settings.TWITTER_USERNAME}_${datestr}_interactions_context`,
      context,
    );

    const response = await this.runtime.messageCompletion({
      context,
      stop: [],
      temperature: this.temperature,
      model: this.runtime.model,
    });
    log_to_file(
      `${settings.TWITTER_USERNAME}_${datestr}_interactions_response`,
      JSON.stringify(response),
    );

    if (response.text) {
      try {
        if (!this.dryRun) {
          const callback: HandlerCallback = async (response: Content) => {
            const memories = await sendTweetChunks(
              this,
              response,
              message.roomId,
              settings.TWITTER_USERNAME,
            );
            return memories;
          };

          const responseMessages = await callback(response);

          state = (await this.runtime.updateRecentMessageState(
            state,
          )) as State;

          for (const responseMessage of responseMessages) {
            await this.runtime.messageManager.createMemory(responseMessage);
          }

          await this.runtime.evaluate(message, state);

          await this.runtime.processActions(message, responseMessages, state);
        } else {
          console.log("Dry run, not sending tweet:", response.text);
        }
        const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
        // f tweets folder dont exist, create
        if (!fs.existsSync("tweets")) {
          fs.mkdirSync("tweets");
        }
        const debugFileName = `tweets/tweet_generation_${tweet.id}.txt`;
        fs.writeFileSync(debugFileName, responseInfo);
        await wait();
      } catch (error) {
        console.error(`Error sending response tweet: ${error}`);
      }
    }
  }
}
