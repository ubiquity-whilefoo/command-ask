import { createActionsPlugin } from "@ubiquity-os/plugin-sdk";
import { createAdapters } from "./adapters";
import { SupportedEvents } from "./types/context";
import { Env, envSchema } from "./types/env";
import { PluginSettings, pluginSettingsSchema } from "./types/plugin-input";
import { Command } from "./types/command";
import { plugin } from "./plugin";
import { LogLevel } from "@ubiquity-os/ubiquity-os-logger";

createActionsPlugin<PluginSettings, Env, Command, SupportedEvents>(
  (context) => {
    return plugin({
      ...context,
      adapters: {} as ReturnType<typeof createAdapters>,
    });
  },
  {
    envSchema: envSchema,
    postCommentOnError: true,
    settingsSchema: pluginSettingsSchema,
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    kernelPublicKey: process.env.KERNEL_PUBLIC_KEY,
  }
).catch(console.error);
