#!/usr/bin/env node
/**
 * **The `effect-drizzle-kit` bin**: {@link cli} over the process's arguments,
 * with the Node services, run by `NodeRuntime.runMain` (which sets the exit
 * code and prints a failure's message).
 *
 * @module bin
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { cli, version } from "./commands.ts";

cli.pipe(Command.run({ version }), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
