import { describe, expect, test } from "bun:test";
import { engagementContext } from "../src/ardent/prompt";
import { parseScope } from "../src/ardent/scope";

const scope = parseScope(["10.0.0.0/24"]);

describe("engagementContext", () => {
  test("returns undefined with no scope — the extension stays ordinary free-pi", () => {
    expect(engagementContext({ scope: parseScope([]) })).toBeUndefined();
  });

  test("names the scope and the rules of engagement", () => {
    const brief = engagementContext({ scope })!;
    expect(brief).toContain("[ARDENT ENGAGEMENT ACTIVE]");
    expect(brief).toContain("10.0.0.0/24");
    expect(brief).toContain("Rules of engagement:");
    expect(brief).toContain("OUT OF SCOPE");
  });

  test("a configured scope is authorization, not an instruction to start working", () => {
    // Regression: with the engagement brief injected every turn and no rule
    // telling the model otherwise, a bare "hello" triggered a full recon run —
    // the role brief ("what the agent is FOR") was read as a standing order.
    const brief = engagementContext({ scope })!;
    expect(brief).toContain("A configured scope is AUTHORIZATION, not an instruction");
    expect(brief).toContain("Greet and answer questions as a normal assistant");
    expect(brief).toContain("until the user asks for engagement work or states an objective");
  });

  test("the converse-first rule comes before the scope rules a model might over-read", () => {
    const brief = engagementContext({ scope })!;
    const authorizationIdx = brief.indexOf("A configured scope is AUTHORIZATION");
    const scopeRuleIdx = brief.indexOf("Only interact with targets listed above");
    expect(authorizationIdx).toBeGreaterThan(-1);
    expect(authorizationIdx).toBeLessThan(scopeRuleIdx);
  });

  test("asks a clarifying question when the objective is ambiguous", () => {
    // Same failure mode as the converse-first rule: a bare objective ("look at
    // the target") with no rule to the contrary invites the model to pick the
    // most interesting interpretation and run with it. A wrong guess against a
    // live target costs more than a clarifying turn.
    const brief = engagementContext({ scope })!;
    expect(brief).toContain("If the objective is ambiguous");
    expect(brief).toContain("ask a clarifying question before acting");
    expect(brief).toContain("Do not guess at scope or intent");
  });

  test("the clarifying-question rule also precedes the scope rules", () => {
    const brief = engagementContext({ scope })!;
    const clarifyIdx = brief.indexOf("If the objective is ambiguous");
    const scopeRuleIdx = brief.indexOf("Only interact with targets listed above");
    expect(clarifyIdx).toBeGreaterThan(-1);
    expect(clarifyIdx).toBeLessThan(scopeRuleIdx);
  });

  test("states that the engagement is authorized before it states the boundary", () => {
    // Order is the point. A model that meets the scope list first can read an
    // authorized step as something it is being asked to adjudicate and decline.
    const brief = engagementContext({ scope })!;
    const authorizedIdx = brief.indexOf("This engagement is authorized");
    const scopeRuleIdx = brief.indexOf("Only interact with targets listed above");
    expect(authorizedIdx).toBeGreaterThan(-1);
    expect(authorizedIdx).toBeLessThan(scopeRuleIdx);
    // The gate is named as the actual boundary, not the model's judgement.
    expect(brief).toContain("blocked before they execute");
  });

  test("tells the agent not to re-litigate authorization, but keeps declining available", () => {
    const brief = engagementContext({ scope })!;
    expect(brief).toContain("Do not re-litigate authorization you have been given");
    expect(brief).toContain("Do not ask for confirmation the operator has already provided");
    // The escape hatch stays: out-of-scope work is still a decline.
    expect(brief).toContain("genuinely outside the scope or the rules below");
    expect(brief).toContain("say so once, in one line, and stop");
  });

  test("frames the destructive/privileged rule as the single exception, not a general ask-first rule", () => {
    const brief = engagementContext({ scope })!;
    expect(brief).toContain("the one exception where you confirm first");
    expect(brief).toContain("everything in scope short of that, proceed");
  });

  test("includes the role brief and working memory when given", () => {
    const brief = engagementContext({
      scope,
      role: "recon",
      workingMemory: "- 10.0.0.5: port 22 open",
    })!;
    expect(brief).toContain("You are RECON");
    expect(brief).toContain("Working memory:");
    expect(brief).toContain("10.0.0.5: port 22 open");
  });
});
