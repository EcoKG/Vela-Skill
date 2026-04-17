/**
 * Vela Core — Pipeline definition + step resolution + exit-gate checks (v7.3-M4e)
 *
 * Extracted from scripts/cli/vela-engine.js during the v8.0 engine
 * decomposition. Three responsibilities:
 *
 *   loadPipelineDefinition()
 *     Read + parse .vela/templates/pipeline.json. Returns null on any
 *     error so callers don't crash when the file is absent (first boot)
 *     or malformed (config-tamper blocked by VG-13 upstream).
 *
 *   resolveSteps(pipelineDef, pipelineType)
 *     Walk the pipeline graph:
 *       - inherits + steps_only → pull parent, filter
 *       - no inherits + steps_only → own steps, filter
 *       - else → own steps as-is
 *     Apply per-step overrides when declared. Pure — no I/O.
 *
 *   checkExitGate(stepDef, state)
 *     Evaluate every gate listed in stepDef.exit_gate against the
 *     current pipeline state and its artifact directory. Returns
 *     { passed: boolean, missing: string[] } where `missing` carries
 *     machine-readable reason codes (e.g. "approval_missing:...").
 *
 * The three are exposed via a factory to avoid threading templatesDir/
 * velaDir/cwd through every call site. The engine calls resolveSteps
 * in several hot paths (cmdState, cmdTransition, cmdAdvance), so
 * keeping those signatures stable matters.
 *
 * Usage:
 *   const { loadPipelineDefinition, resolveSteps, checkExitGate } =
 *     require("../core/pipeline")({
 *       templatesDir: TEMPLATES_DIR,
 *       velaDir:      VELA_DIR,
 *       cwd:          CWD,
 *     });
 */

"use strict";

const fs = require("fs");
const path = require("path");

function createPipelineLoader({ templatesDir, velaDir, cwd }) {
  function loadPipelineDefinition() {
    const pipelinePath = path.join(templatesDir, "pipeline.json");
    if (!fs.existsSync(pipelinePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(pipelinePath, "utf-8"));
    } catch (e) {
      return null;
    }
  }

  function resolveSteps(pipelineDef, pipelineType) {
    if (!pipelineDef) return [];
    const pipeline = pipelineDef.pipelines[pipelineType || "standard"];
    if (!pipeline) return [];

    // Resolve base step list:
    //   - inherits + steps_only → pull from parent, filter by steps_only
    //   - no inherits + steps_only → own `steps` array, filter by steps_only
    //     (this is the case for "standard" after v7.0 skeleton commit —
    //     the steps array contains extra v7 skeletons like spec/patch
    //     that must be excluded from the default standard flow)
    //   - no steps_only → own `steps` array as-is
    let steps;
    if (pipeline.inherits) {
      const parent = pipelineDef.pipelines[pipeline.inherits];
      if (!parent) return [];
      steps = pipeline.steps_only
        ? parent.steps.filter((s) => pipeline.steps_only.includes(s.id))
        : parent.steps;
    } else {
      steps = pipeline.steps_only
        ? pipeline.steps.filter((s) => pipeline.steps_only.includes(s.id))
        : pipeline.steps;
    }

    // Apply per-step overrides if declared
    if (pipeline.overrides) {
      steps = steps.map((s) =>
        pipeline.overrides[s.id] ? { ...s, ...pipeline.overrides[s.id] } : s,
      );
    }

    return steps;
  }

  function checkExitGate(stepDef, state) {
    if (!stepDef || !stepDef.exit_gate || stepDef.exit_gate.length === 0) {
      return { passed: true, missing: [] };
    }

    const artifactDir = state._artifactDir;
    const missing = [];

    for (const gate of stepDef.exit_gate) {
      switch (gate) {
        case "artifact_dir_created":
          if (!artifactDir || !fs.existsSync(artifactDir)) missing.push(gate);
          break;
        case "mode_detected":
          // Always passes after init
          break;
        case "init_complete":
          if (!state.completed_steps.includes("init")) missing.push(gate);
          break;
        case "research_md_exists":
          if (
            !artifactDir ||
            !fs.existsSync(path.join(artifactDir, "research.md"))
          )
            missing.push(gate);
          break;
        case "targets_json_exists":
          // v6.1 universal locate gate — every pipeline scale's `locate` step
          // produces this artifact via `vela-engine locate`
          if (
            !artifactDir ||
            !fs.existsSync(path.join(artifactDir, "targets.json"))
          )
            missing.push(gate);
          break;
        case "plan_md_exists":
          if (!artifactDir || !fs.existsSync(path.join(artifactDir, "plan.md")))
            missing.push(gate);
          break;
        // v8.0 (v7.3-M3): plan_check_pass + user_approved gates 제거 —
        // plan 단계의 ## Self-Check 섹션이 plan-checker 역할 흡수, checkpoint 단계 삭제.
        case "patch_spec_complete":
          // v7.0 skeleton exit gate — patch-spec.md must exist with required
          // sections. Mirrors plan_architecture_complete but for spec stage.
          // Required sections: ## Before, ## After, ## Explicitly out of scope
          if (
            artifactDir &&
            fs.existsSync(path.join(artifactDir, "patch-spec.md"))
          ) {
            const specContent = fs.readFileSync(
              path.join(artifactDir, "patch-spec.md"),
              "utf-8",
            );
            const required = [
              "## Before",
              "## After",
              "## Explicitly out of scope",
            ];
            for (const section of required) {
              if (!specContent.includes(section)) {
                missing.push(`patch_spec_missing_section:${section}`);
              }
            }
          } else {
            missing.push("patch_spec_missing:patch-spec.md");
          }
          break;
        case "plan_architecture_complete":
          // Standard pipeline: plan.md must contain architecture sections with substance
          if (artifactDir && fs.existsSync(path.join(artifactDir, "plan.md"))) {
            const planContent = fs.readFileSync(
              path.join(artifactDir, "plan.md"),
              "utf-8",
            );
            const requiredSections = [
              "## Architecture",
              "## Class Specification",
              "## Test Strategy",
            ];
            for (const section of requiredSections) {
              if (!planContent.includes(section)) {
                missing.push(`plan_missing_section:${section}`);
              } else {
                // Check section has substance (not just a header)
                const sectionIdx = planContent.indexOf(section);
                const nextSectionIdx = planContent.indexOf(
                  "\n## ",
                  sectionIdx + section.length,
                );
                const sectionContent =
                  nextSectionIdx > 0
                    ? planContent.substring(
                        sectionIdx + section.length,
                        nextSectionIdx,
                      )
                    : planContent.substring(sectionIdx + section.length);
                if (sectionContent.trim().length < 200) {
                  missing.push(`plan_section_too_short:${section}`);
                }
              }
            }
          }
          break;
        case "approval_exists":
        case "leader_approved": // backward compatibility
          // File-based: PM writes approval-{step}.json with decision: "approve"
          if (artifactDir) {
            const approvalPath = path.join(
              artifactDir,
              `approval-${state.current_step}.json`,
            );
            if (!fs.existsSync(approvalPath)) {
              missing.push(
                `approval_missing:approval-${state.current_step}.json`,
              );
            } else {
              try {
                const approval = JSON.parse(
                  fs.readFileSync(approvalPath, "utf-8"),
                );
                if (approval.decision !== "approve") {
                  missing.push(`rejected:${state.current_step}`);
                }
              } catch (e) {
                missing.push(`approval_invalid:${state.current_step}`);
              }
            }
          }
          break;
        case "review_exists":
        case "leader_review_exists": // backward compatibility
          // Reviewer subagent writes review-{step}.md
          if (artifactDir) {
            const reviewPath = path.join(
              artifactDir,
              `review-${state.current_step}.md`,
            );
            if (!fs.existsSync(reviewPath)) {
              missing.push(`review_missing:review-${state.current_step}.md`);
            }
          }
          break;
        case "implementation_complete":
          // File-based: approval-{current_step}.json must exist with decision: "approve"
          // v7.0: this gate is reused by both the legacy `execute` step and the
          // new `patch` step (surgical pipeline). Resolve the approval filename
          // from state.current_step so both steps share one implementation.
          if (artifactDir) {
            const implStep = state.current_step || "execute";
            const approvalFile = `approval-${implStep}.json`;
            const implApprovalPath = path.join(artifactDir, approvalFile);
            if (!fs.existsSync(implApprovalPath)) {
              missing.push(`approval_missing:${approvalFile}`);
            } else {
              try {
                const approval = JSON.parse(
                  fs.readFileSync(implApprovalPath, "utf-8"),
                );
                if (approval.decision !== "approve") {
                  missing.push(`rejected:${implStep}`);
                }
              } catch (e) {
                missing.push(`approval_invalid:${implStep}`);
              }
            }
          }
          break;
        case "git_clean":
          // Init gate: working tree must be clean (checked during init, always passes after)
          break;
        // v8.0 (v7.3-M3): branch_created gate 제거 — branch 단계 삭제 후 init이 브랜치 생성 흡수.
        case "changes_committed":
          // Commit gate: commit hash recorded in state
          if (state.git && state.git.is_repo) {
            if (!state.git.commit_hash && state.current_step === "commit") {
              if (!state.revisions.commit || state.revisions.commit < 1) {
                missing.push(gate);
              }
            }
          }
          break;
        case "verification_md_exists":
          if (
            !artifactDir ||
            (!fs.existsSync(path.join(artifactDir, "verification.md")) &&
              !fs.existsSync(path.join(artifactDir, "verify.md")))
          )
            missing.push(gate);
          break;
        // v8.0 (v7.3-M3): report_md_exists gate 제거 — finalize 단계 삭제 후 commit이 git diff --stat으로 요약 생성.
        case "ref_integrity": {
          // Change Surface Analysis — verify no broken cross-file references
          const baselineSha =
            state.baseline_sha || (state.git && state.git.checkpoint_hash);
          if (!baselineSha) {
            // Legacy pipeline without baseline — skip gracefully
            break;
          }
          try {
            const configPath = path.join(velaDir, "templates", "config.json");
            let csaOpts = {};
            if (fs.existsSync(configPath)) {
              const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
              if (cfg.changeSurface) {
                if (cfg.changeSurface.enabled === false) break;
                if (cfg.changeSurface.excludePaths) {
                  csaOpts.excludePaths = cfg.changeSurface.excludePaths;
                }
              }
            }
            const { analyze } = require("../shared/change-surface.js");
            const result = analyze(baselineSha, { cwd, ...csaOpts });
            if (!result.verdict.pass) {
              missing.push(
                `ref_integrity_fail:${result.verdict.errorCount} broken ref(s)`,
              );
            }
          } catch (e) {
            // CSA module error — don't block pipeline, warn only
            console.error(`[ref_integrity] Warning: ${e.message}`);
          }
          break;
        }
        default:
          // Unknown gate, skip
          break;
      }
    }

    return { passed: missing.length === 0, missing };
  }

  return { loadPipelineDefinition, resolveSteps, checkExitGate };
}

module.exports = createPipelineLoader;
