/**
 * Vela state-machine commands — state / transition / record / advance (v7.3-M4e-p6)
 *
 * Extracted from scripts/cli/vela-engine.js. This is the pipeline state
 * machine proper — the four commands that actually drive a pipeline
 * forward (or back) plus the two helpers they share:
 *
 *   cmdState       Snapshot the current step with v7.2 M2 model-routing,
 *                  v7.2 M13 task records, v7.1 M7 context-pack path.
 *   cmdTransition  Advance to the next step after exit_gate passes.
 *                  Also clears circuit-open.json + review-gate state.
 *   cmdRecord      Record pass/fail/reject on the current step.
 *                  Trips the VG-15 circuit breaker at 5 consecutive
 *                  fails. Auto-disables --auto mode after 2 rejects.
 *   cmdAdvance     One-shot record + transition (v7.1 M8 optimization).
 *                  Returns a nextAction hint so the PM skips a round-
 *                  trip `state` call.
 *   applyVerdict   Pure in-memory mutation shared by record + advance.
 *                  Returns {autoDisabled, autoWarning, circuitOpened}
 *                  so callers can emit the right response shape.
 *   nextActionHint v8.0 ship-pipeline 6-step lookup table. Non-
 *                  authoritative — the PM is still the decision maker.
 *
 * All six are bundled in a single module because they share closure
 * state (CIRCUIT_BREAKER_THRESHOLD) and applyVerdict is only ever
 * called by record/advance. Splitting would force re-require chains
 * for one or two functions.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// VG-15 trigger: 5 consecutive fail/reject verdicts on a single step
// open the circuit. gate-guard (now merged into vela-gate.js) reads
// .vela/state/circuit-open.json and blocks further tool use.
const CIRCUIT_BREAKER_THRESHOLD = 5;

module.exports = function createStateMachine(ctx) {
  const {
    CWD,
    VELA_DIR,
    getArg,
    getFlag,
    findActiveState,
    loadPipelineDefinition,
    resolveSteps,
    checkExitGate,
    writeJSON,
    cleanState,
    output,
  } = ctx;

  // ─── nextActionHint (shared by cmdAdvance, could be used by cmdState) ──

  /**
   * v7.1 M8: return a short one-line hint for what the PM should do next
   * at a given step. Used by `advance` so the PM can skip an extra
   * `state` round-trip to decide which agent to spawn.
   *
   * justAdvanced === true → we're saying "you just moved INTO stepId,
   * here's what to run". false → "you're still ON stepId, here's the
   * retry path".
   *
   * Non-authoritative: the table is tiny. If a step is missing it falls
   * back to "see agents/vela.md for this step".
   */
  function nextActionHint(state, stepId, justAdvanced) {
    const pipelineType = state && state.pipeline_type;
    // v8.0 (v7.3-M3): ship 파이프라인 6단계 고정 매핑.
    //   plan    이  research + plan-check 흡수
    //   verify  가  diff-summary 흡수 (reviewer 모드)
    //   commit  이  branch + finalize 흡수
    const table = {
      init: "run `vela-engine advance` to move into locate (init도 vela/{slug} 브랜치 자동 생성)",
      locate: "run `vela-engine locate` (generates targets.json)",
      plan: "spawn vela-planner (research+plan+self-check 통합) then vela-reviewer; call `advance pass` on approve. fix 파이프라인에선 mode=spec로 patch-spec.md 생성.",
      execute: "spawn vela-executor then vela-reviewer; call `advance pass` on approve",
      verify: "spawn vela-reviewer (테스트+린트+타입체크+diff 요약 통합); >500 LOC diff이면 /ultrareview 번들 스킬 에스컬레이션",
      commit: "run `vela-engine commit` — Conventional Commits + git diff --stat 요약으로 파이프라인 종료",
    };
    const hint = table[stepId];
    if (!hint) return `see agents/vela.md for step ${stepId} (${pipelineType || "unknown pipeline"})`;
    return justAdvanced ? hint : `retry: ${hint}`;
  }

  // ─── applyVerdict (shared by cmdRecord, cmdAdvance) ─────────────

  /**
   * v7.1 M8: apply a verdict (pass/fail/reject) to the active pipeline
   * state in memory. Returns the auto-mode/circuit-breaker side effects
   * but does NOT write to disk — callers compose this with transition
   * when running the advance shortcut, so both mutations flush in one
   * writeJSON call.
   */
  function applyVerdict(state, verdictLower) {
    if (!state.revisions[state.current_step]) {
      state.revisions[state.current_step] = 0;
    }
    state.revisions[state.current_step]++;

    const result = {
      autoDisabled: false,
      autoWarning: null,
      circuitOpened: false,
    };

    if (state.auto === true) {
      if (verdictLower === "reject" || verdictLower === "fail") {
        state.auto_reject_count = (state.auto_reject_count || 0) + 1;
        if (state.auto_reject_count >= 2) {
          state.auto = false;
          result.autoDisabled = true;
          result.autoWarning =
            "⚠️ Auto mode disabled: 2 consecutive rejects reached.";
        }
      } else if (verdictLower === "pass" || verdictLower === "approve") {
        state.auto_reject_count = 0;
      }
    }

    const failKey = `_step_failures_${state.current_step}`;
    if (verdictLower === "fail" || verdictLower === "reject") {
      state[failKey] = (state[failKey] || 0) + 1;
      if (state[failKey] >= CIRCUIT_BREAKER_THRESHOLD) {
        result.circuitOpened = true;
        try {
          const stateDir = path.join(CWD, ".vela", "state");
          fs.mkdirSync(stateDir, { recursive: true });
          writeJSON(path.join(stateDir, "circuit-open.json"), {
            step: state.current_step,
            count: state[failKey],
            openAt: new Date().toISOString(),
          });
        } catch { /* silent */ }
      }
    } else if (verdictLower === "pass") {
      state[failKey] = 0;
      try {
        const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
        if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
      } catch { /* silent */ }
    }

    state.updated_at = new Date().toISOString();
    return result;
  }

  // ─── cmdState ───────────────────────────────────────────────────

  function cmdState() {
    const state = findActiveState();
    if (!state) {
      return output({
        ok: true,
        command: "state",
        active: false,
        message: "No active pipeline.",
      });
    }

    const pipelineDef = loadPipelineDefinition();
    const steps = resolveSteps(pipelineDef, state.pipeline_type);
    const currentStepDef = steps.find((s) => s.id === state.current_step);

    // v7.2 M1/M2 — Derive per-role model recommendation + cache policy
    // from .vela/config.json. PM passes recommended_model into Agent()
    // spawns; missing config → null (PM inherits session model).
    let recommendedModel = null;
    let cacheConfig = null;
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(VELA_DIR, "config.json"), "utf8"),
      );
      if (cfg && typeof cfg === "object") {
        const models = cfg.models;
        if (models && typeof models === "object") {
          const stepKey = String(state.current_step || "").replace(/-/g, "_");
          recommendedModel = models[stepKey] || models.default || null;
        }
        cacheConfig = cfg.cache || null;
      }
    } catch {
      /* config missing or malformed — non-fatal, defaults to null */
    }

    output({
      ok: true,
      command: "state",
      active: true,
      pipeline_type: state.pipeline_type,
      scale: state.scale || "standard",
      request: state.request,
      current_step: state.current_step,
      current_step_name: currentStepDef
        ? currentStepDef.name
        : state.current_step,
      current_mode: currentStepDef ? currentStepDef.mode : "read",
      completed_steps: state.completed_steps,
      remaining_steps: state.steps.filter(
        (s) => !state.completed_steps.includes(s),
      ),
      auto: state.auto || false,
      revisions: state.revisions,
      sub_phase: state.sub_phases
        ? state.sub_phases[state.current_step] || null
        : null,
      git: state.git || null,
      artifact_dir: state._artifactDir,
      recommended_model: recommendedModel,
      cache_config: cacheConfig,
      // v7.2 M13 — Pipeline steps as task records, suitable for the PM
      // to hand to Claude Code's session-level task-list tool on init and
      // to update on each transition. Engine cannot call Claude Code tools
      // itself; this is the structured input it hands to the PM.
      tasks: Array.isArray(state.steps) ? state.steps.map((id, idx) => {
        const def = steps.find((s) => s.id === id);
        const isDone = Array.isArray(state.completed_steps) && state.completed_steps.includes(id);
        const isCurrent = id === state.current_step;
        return {
          id: `vela-${state.pipeline_type || "pipeline"}-${idx}-${id}`,
          content: def ? def.name || id : id,
          status: isDone ? "completed" : (isCurrent ? "in_progress" : "pending"),
        };
      }) : [],
      // v7.1 M7: surface context-pack path so the PM can hand it to
      // executor/verifier spawns without having to check the filesystem
      // itself. Also exposes budget-exceeded.json if it was dropped.
      contextPackPath: state._artifactDir && fs.existsSync(
        path.join(state._artifactDir, "context-pack.json"),
      ) ? path.join(state._artifactDir, "context-pack.json") : null,
      requestTxtPath: state._artifactDir && fs.existsSync(
        path.join(state._artifactDir, "request.txt"),
      ) ? path.join(state._artifactDir, "request.txt") : null,
    });
  }

  // ─── cmdTransition ──────────────────────────────────────────────

  function cmdTransition() {
    const state = findActiveState();
    if (!state) {
      return output({ ok: false, error: "No active pipeline to transition." });
    }

    const pipelineDef = loadPipelineDefinition();
    const steps = resolveSteps(pipelineDef, state.pipeline_type);
    const currentIdx = steps.findIndex((s) => s.id === state.current_step);

    if (currentIdx < 0) {
      return output({
        ok: false,
        error: `Current step "${state.current_step}" not found in pipeline.`,
      });
    }

    // Check exit gate for current step
    const currentStepDef = steps[currentIdx];
    const gateResult = checkExitGate(currentStepDef, state);
    if (!gateResult.passed) {
      return output({
        ok: false,
        error: `Exit gate not met for step "${state.current_step}"`,
        missing: gateResult.missing,
        message: `Complete these requirements before advancing: ${gateResult.missing.join(", ")}`,
      });
    }

    // Mark current step as completed
    if (!state.completed_steps.includes(state.current_step)) {
      state.completed_steps.push(state.current_step);
    }

    // Check if this was the last step
    if (currentIdx >= steps.length - 1) {
      state.status = "completed";
      state.current_step = "done";
      state.updated_at = new Date().toISOString();
      writeJSON(state._path, cleanState(state));

      return output({
        ok: true,
        command: "transition",
        completed: true,
        message: "Pipeline completed successfully.",
      });
    }

    // Reset circuit state for the step we're leaving
    const prevFailKey = `_step_failures_${state.current_step}`;
    delete state[prevFailKey];
    try {
      const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
      if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
    } catch { /* silent */ }

    // Reset review gate state for the step we're leaving
    try {
      const gateStatePath = path.join(CWD, ".vela", "state", `review-gate-${state.current_step}.json`);
      if (fs.existsSync(gateStatePath)) fs.unlinkSync(gateStatePath);
    } catch { /* silent */ }

    // Advance to next step
    const nextStep = steps[currentIdx + 1];
    state.current_step = nextStep.id;
    state.current_step_index = currentIdx + 1;
    state.updated_at = new Date().toISOString();

    // V6: no in-memory team state needed.
    // PM orchestrates via Agent(subagent_type=...) + file artifacts (approval-{step}.json, review-{step}.md).

    // Initialize sub-phase tracking if step has sub_phases and tracking enabled
    if (nextStep.sub_phases && nextStep.sub_phase_tracking) {
      if (!state.sub_phases) state.sub_phases = {};
      state.sub_phases[nextStep.id] = {
        phases: nextStep.sub_phases,
        current_index: 0,
        current_phase: nextStep.sub_phases[0],
        completed_phases: [],
      };
    }

    writeJSON(state._path, cleanState(state));

    output({
      ok: true,
      command: "transition",
      previous_step: currentStepDef.id,
      current_step: nextStep.id,
      current_step_name: nextStep.name,
      current_mode: nextStep.mode,
      completed: false,
      message: `Advanced to: ${nextStep.name} (${nextStep.mode} mode)`,
    });
  }

  // ─── cmdRecord ──────────────────────────────────────────────────

  function cmdRecord() {
    const verdict = getArg(0);
    if (!verdict || !["pass", "fail", "reject"].includes(verdict.toLowerCase())) {
      return output({
        ok: false,
        error: "Verdict required: pass, fail, or reject",
      });
    }

    const state = findActiveState();
    if (!state) {
      return output({ ok: false, error: "No active pipeline." });
    }

    const summary = getFlag("--summary") || "";
    const verdictLower = verdict.toLowerCase();

    // Delegate the mutation to applyVerdict (shared with cmdAdvance).
    const verdictResult = applyVerdict(state, verdictLower);
    writeJSON(state._path, cleanState(state));

    const result = {
      ok: true,
      command: "record",
      step: state.current_step,
      verdict: verdictLower,
      revision: state.revisions[state.current_step],
      summary: summary,
    };

    if (verdictResult.autoDisabled) {
      result.auto_disabled = true;
      result.auto_warning = verdictResult.autoWarning;
    }

    output(result);
  }

  // ─── cmdAdvance ─────────────────────────────────────────────────

  /**
   * v7.1 M8: advance — record(verdict) + transition as one atomic CLI call.
   *
   * Motivation: hicoco session analysis showed the PM's top-level Bash
   * count was 146, the largest single consumer being "record pass" followed
   * immediately by "transition" on every successful step. advance halves
   * that latency and also lets the engine return a `nextAction` hint so the
   * PM can skip an extra `state` round-trip just to find out which agent to
   * spawn next.
   *
   * Behaviour by verdict:
   *   pass  (default) — record pass, transition to next step
   *   fail  — record fail, stay on current step (no transition)
   *   reject — record reject, stay on current step (no transition)
   *
   * Output JSON includes: previousStep, currentStep, nextStep, active,
   * circuitOpen, and nextAction (a one-line hint like "spawn vela-executor"
   * or "commit via `vela-engine commit`").
   */
  function cmdAdvance() {
    const rawVerdict = getArg(0) || "pass";
    const verdictLower = rawVerdict.toLowerCase();
    if (!["pass", "fail", "reject"].includes(verdictLower)) {
      return output({
        ok: false,
        command: "advance",
        error: "Verdict must be one of pass|fail|reject (default: pass)",
      });
    }

    const state = findActiveState();
    if (!state) {
      return output({
        ok: false,
        command: "advance",
        error: "No active pipeline.",
      });
    }

    const previousStep = state.current_step;
    const verdictResult = applyVerdict(state, verdictLower);

    // fail/reject: stay on the same step — same semantics as cmdRecord alone.
    if (verdictLower !== "pass") {
      writeJSON(state._path, cleanState(state));
      return output({
        ok: true,
        command: "advance",
        verdict: verdictLower,
        previousStep,
        currentStep: state.current_step,
        nextStep: null,
        active: true,
        circuitOpen: verdictResult.circuitOpened,
        revision: state.revisions[previousStep],
        ...(verdictResult.autoDisabled ? {
          autoDisabled: true,
          autoWarning: verdictResult.autoWarning,
        } : {}),
        nextAction: nextActionHint(state, previousStep, false),
        message: `Recorded ${verdictLower} on step ${previousStep}. Pipeline stays on ${previousStep} for retry.`,
      });
    }

    // pass → advance. Re-read state (applyVerdict already wrote; we need
    // a fresh snapshot with side-effects persisted) then replay
    // cmdTransition's exit-gate + step-advancement logic inline so the
    // output can include both previousStep/nextStep in one payload.
    writeJSON(state._path, cleanState(state));

    const fresh = findActiveState();
    if (!fresh) {
      return output({
        ok: false,
        command: "advance",
        error: "Pipeline disappeared mid-advance (race?). Run `state`.",
      });
    }
    const pipelineDef = loadPipelineDefinition();
    const steps = resolveSteps(pipelineDef, fresh.pipeline_type);
    const currentIdx = steps.findIndex((s) => s.id === fresh.current_step);
    if (currentIdx < 0) {
      return output({
        ok: false,
        command: "advance",
        error: `Current step "${fresh.current_step}" not found in pipeline.`,
      });
    }

    const currentStepDef = steps[currentIdx];
    const gateResult = checkExitGate(currentStepDef, fresh);
    if (!gateResult.passed) {
      return output({
        ok: false,
        command: "advance",
        error: `Exit gate not met for step "${fresh.current_step}"`,
        missing: gateResult.missing,
        message: `Complete these requirements before advancing: ${gateResult.missing.join(", ")}`,
      });
    }

    if (!fresh.completed_steps.includes(fresh.current_step)) {
      fresh.completed_steps.push(fresh.current_step);
    }

    if (currentIdx >= steps.length - 1) {
      fresh.status = "completed";
      fresh.current_step = "done";
      fresh.updated_at = new Date().toISOString();
      writeJSON(fresh._path, cleanState(fresh));
      return output({
        ok: true,
        command: "advance",
        verdict: "pass",
        previousStep,
        currentStep: "done",
        nextStep: null,
        active: false,
        completed: true,
        revision: fresh.revisions[previousStep] || 1,
        circuitOpen: false,
        nextAction: "pipeline-complete",
        message: "Pipeline completed successfully.",
      });
    }

    // Same cleanup cmdTransition does
    const prevFailKey = `_step_failures_${fresh.current_step}`;
    delete fresh[prevFailKey];
    try {
      const circuitPath = path.join(CWD, ".vela", "state", "circuit-open.json");
      if (fs.existsSync(circuitPath)) fs.unlinkSync(circuitPath);
    } catch { /* silent */ }
    try {
      const gateStatePath = path.join(
        CWD, ".vela", "state", `review-gate-${fresh.current_step}.json`,
      );
      if (fs.existsSync(gateStatePath)) fs.unlinkSync(gateStatePath);
    } catch { /* silent */ }

    const nextStep = steps[currentIdx + 1];
    fresh.current_step = nextStep.id;
    fresh.current_step_index = currentIdx + 1;
    fresh.updated_at = new Date().toISOString();
    if (nextStep.sub_phases && nextStep.sub_phase_tracking) {
      if (!fresh.sub_phases) fresh.sub_phases = {};
      fresh.sub_phases[nextStep.id] = {
        phases: nextStep.sub_phases,
        current_index: 0,
        current_phase: nextStep.sub_phases[0],
        completed_phases: [],
      };
    }
    writeJSON(fresh._path, cleanState(fresh));

    const nextNextStep = steps[currentIdx + 2] || null;
    output({
      ok: true,
      command: "advance",
      verdict: "pass",
      previousStep,
      currentStep: nextStep.id,
      currentStepName: nextStep.name,
      currentMode: nextStep.mode,
      nextStep: nextNextStep ? nextNextStep.id : null,
      active: true,
      completed: false,
      revision: fresh.revisions[previousStep] || 1,
      circuitOpen: false,
      nextAction: nextActionHint(fresh, nextStep.id, true),
      message: `Recorded pass on ${previousStep} → advanced to ${nextStep.name} (${nextStep.mode} mode)`,
    });
  }

  return { cmdState, cmdTransition, cmdRecord, cmdAdvance };
};
