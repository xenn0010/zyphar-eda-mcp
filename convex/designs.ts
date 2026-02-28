import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createDesign = mutation({
  args: {
    jobId: v.string(),
    designName: v.string(),
    pdk: v.string(),
    tool: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("designs", {
      ...args,
      status: "running",
      createdAt: Date.now(),
    });
  },
});

export const completeDesign = mutation({
  args: {
    jobId: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    cells: v.optional(v.string()),
    area: v.optional(v.string()),
    wns: v.optional(v.string()),
    duration: v.optional(v.string()),
    gdsFileId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const design = await ctx.db
      .query("designs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    if (!design) return null;
    const { jobId, ...updates } = args;
    await ctx.db.patch(design._id, updates);
    return design._id;
  },
});

export const getDesign = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("designs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
  },
});

export const listDesigns = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("designs").order("desc").take(50);
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const getDownloadUrl = query({
  args: { fileId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.fileId);
  },
});
