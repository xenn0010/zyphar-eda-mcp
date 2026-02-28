import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  designs: defineTable({
    jobId: v.string(),
    designName: v.string(),
    pdk: v.string(),
    tool: v.string(),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    cells: v.optional(v.string()),
    area: v.optional(v.string()),
    wns: v.optional(v.string()),
    duration: v.optional(v.string()),
    gdsFileId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  }).index("by_jobId", ["jobId"]),
});
