#!/usr/bin/env node
/**
 * ⛵ Vela Analyze — Dependency analysis + PDF report generation
 *
 * Subcommands:
 *   deps              Run npm audit/outdated analysis, output JSON to stdout
 *   report --input <file> [--output <file>]   Generate PDF report from analysis JSON
 *
 * Usage:
 *   node vela-analyze.js deps
 *   node vela-analyze.js report --input analysis.json --output report.pdf
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { MODEL_VERSIONS } = require('../shared/constants');

// ─── Argument Parsing ───

const args = process.argv.slice(2);
const subcommand = args[0];

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// ─── Module-Level Constants ───

const VALID_PERSPECTIVES = ['security', 'bugs', 'performance', 'code-quality', 'architecture'];
const MODEL_MAP = {
  haiku: MODEL_VERSIONS.HAIKU,
  sonnet: MODEL_VERSIONS.SONNET,
};

function printUsage() {
  console.error(`Usage:
  node vela-analyze.js deps                          — Run dependency analysis (JSON stdout)
  node vela-analyze.js report --input <file> [--output <file>]  — Generate PDF report
  node vela-analyze.js run --perspectives <list> [--model haiku|sonnet]  — Run SDK code analysis
  node vela-analyze.js full --items <list> [--model haiku|sonnet] [--output <file>]  — Run combined analysis + PDF

  run options:
    --perspectives  Comma-separated list of: security,bugs,performance,code-quality,architecture (required)
    --model         Analysis model: haiku (default) or sonnet

  full options:
    --items         Comma-separated list of: deps,security,bugs,performance,code-quality,architecture (required)
    --model         Analysis model: haiku (default) or sonnet
    --output        Output PDF path (default: ./vela-report-{timestamp}.pdf)`);
}

// ─── PDF Generation ───

/**
 * Generate a PDF report from normalized analysis data.
 * @param {Object} data - Analysis result from dep-analyzer.js
 * @param {string} outputPath - Destination PDF file path
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
function generatePdf(data, outputPath) {
  return new Promise((resolve) => {
    let PDFDocument;
    try {
      PDFDocument = require('pdfkit');
    } catch (err) {
      resolve({ ok: false, error: 'pdfkit not installed: ' + err.message });
      return;
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);

    stream.on('error', (err) => {
      resolve({ ok: false, error: 'Stream write error: ' + err.message });
    });

    doc.pipe(stream);

    // ─── Resolve data shape: flat (dep-only) or combined (deps nested under data.deps) ───
    const depData = data.deps || data;
    const hasDeps = !!(depData.findings || depData.outdated || depData.metadata);

    // ─── Title Page ───
    doc.fontSize(24).text('Vela Analysis Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#666666')
      .text((data.generatedAt || new Date().toISOString()).split('T')[0], { align: 'center' });
    doc.fillColor('#000000');
    if (data.selectedItems) {
      doc.fontSize(10).fillColor('#888888')
        .text(`Analysis scope: ${data.selectedItems.join(', ')}`, { align: 'center' });
      doc.fillColor('#000000');
    }
    doc.moveDown(2);

    // ─── Dependency Sections (only when dep data is present) ───
    if (hasDeps) {
    // ─── Summary Statistics ───
    const meta = depData.metadata || {};
    const bySev = meta.bySeverity || {};
    doc.fontSize(16).text('Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text(`Total Vulnerabilities: ${meta.totalVulnerabilities || 0}`);
    doc.text(`  Critical: ${bySev.critical || 0}    High: ${bySev.high || 0}    Moderate: ${bySev.moderate || 0}    Low: ${bySev.low || 0}    Info: ${bySev.info || 0}`);
    doc.text(`Outdated Packages: ${meta.outdatedCount || 0}`);
    doc.moveDown(1.5);

    // ─── Vulnerability Findings ───
    const findings = depData.findings || [];
    doc.fontSize(16).text('Vulnerability Findings', { underline: true });
    doc.moveDown(0.5);

    if (findings.length === 0) {
      doc.fontSize(11).text('No vulnerabilities found.');
    } else {
      // Group by severity
      const severityOrder = ['critical', 'high', 'moderate', 'low', 'info', 'unknown'];
      const grouped = {};
      for (const f of findings) {
        const sev = (f.severity || 'unknown').toLowerCase();
        if (!grouped[sev]) grouped[sev] = [];
        grouped[sev].push(f);
      }

      for (const sev of severityOrder) {
        if (!grouped[sev] || grouped[sev].length === 0) continue;

        const sevColors = {
          critical: '#CC0000',
          high: '#DD4400',
          moderate: '#DD8800',
          low: '#888888',
          info: '#4488CC',
          unknown: '#666666',
        };

        doc.fontSize(13).fillColor(sevColors[sev] || '#000000')
          .text(`${sev.toUpperCase()} (${grouped[sev].length})`, { underline: false });
        doc.fillColor('#000000');
        doc.moveDown(0.3);

        for (const f of grouped[sev]) {
          doc.fontSize(11);
          doc.text(`  Package: ${f.name}`, { continued: false });
          if (f.title) doc.text(`  Title: ${f.title}`);
          doc.text(`  Direct: ${f.isDirect ? 'Yes' : 'No'}    Fix Available: ${f.fixAvailable ? 'Yes' : 'No'}`);
          if (f.url) doc.text(`  URL: ${f.url}`, { link: f.url });
          doc.moveDown(0.5);
        }
      }
    }

    doc.moveDown(1);

    // ─── Outdated Packages ───
    const outdated = depData.outdated || [];
    doc.fontSize(16).fillColor('#000000').text('Outdated Packages', { underline: true });
    doc.moveDown(0.5);

    if (outdated.length === 0) {
      doc.fontSize(11).text('All packages are up to date.');
    } else {
      // Header row
      doc.fontSize(10).fillColor('#444444');
      const colX = { name: 50, current: 200, wanted: 300, latest: 400 };
      const headerY = doc.y;
      doc.text('Package', colX.name, headerY);
      doc.text('Current', colX.current, headerY);
      doc.text('Wanted', colX.wanted, headerY);
      doc.text('Latest', colX.latest, headerY);
      doc.moveDown(0.3);

      // Separator line
      doc.moveTo(50, doc.y).lineTo(500, doc.y).stroke('#CCCCCC');
      doc.moveDown(0.3);

      doc.fillColor('#000000').fontSize(10);
      for (const pkg of outdated) {
        const rowY = doc.y;
        doc.text(pkg.name, colX.name, rowY);
        doc.text(pkg.current, colX.current, rowY);
        doc.text(pkg.wanted, colX.wanted, rowY);
        doc.text(pkg.latest, colX.latest, rowY);
        doc.moveDown(0.5);
      }
    }

    } // end if (hasDeps)

    // ─── Code Analysis (combined report) ───
    if (data.codeAnalysis) {
      doc.moveDown(1);
      doc.fontSize(16).fillColor('#000000').text('Code Analysis', { underline: true });
      doc.moveDown(0.5);

      if (!data.codeAnalysis.ok && (!data.codeAnalysis.perspectives || data.codeAnalysis.perspectives.length === 0)) {
        doc.fontSize(11).fillColor('#CC0000')
          .text(`Code analysis failed: ${data.codeAnalysis.error || 'Unknown error'}`);
        doc.fillColor('#000000');
      } else {
        const perspectives = data.codeAnalysis.perspectives || [];
        for (const p of perspectives) {
          // Perspective heading
          const pName = (p.perspective || 'unknown').charAt(0).toUpperCase() + (p.perspective || 'unknown').slice(1);
          doc.fontSize(13).fillColor('#2255AA')
            .text(`${pName} Analysis`, { underline: false });
          doc.fillColor('#000000');
          doc.moveDown(0.2);

          if (!p.ok) {
            doc.fontSize(11).fillColor('#CC0000')
              .text(`  Analysis failed: ${p.error || 'Unknown error'}`);
            doc.fillColor('#000000');
            doc.moveDown(0.5);
            continue;
          }

          // Metadata line
          doc.fontSize(10).fillColor('#666666')
            .text(`  Findings: ${(p.findings || []).length}    Cost: $${(p.cost || 0).toFixed(3)}    Duration: ${((p.durationMs || 0) / 1000).toFixed(1)}s`);
          doc.fillColor('#000000');
          doc.moveDown(0.3);

          // Findings
          const pFindings = p.findings || [];
          if (pFindings.length === 0) {
            doc.fontSize(11).text('  No findings.');
            doc.moveDown(0.5);
            continue;
          }

          const sevColors = {
            critical: '#CC0000',
            high: '#DD4400',
            moderate: '#DD8800',
            low: '#888888',
            info: '#4488CC',
          };

          for (const f of pFindings) {
            const sev = (f.severity || 'info').toLowerCase();
            doc.fontSize(11);
            doc.fillColor(sevColors[sev] || '#000000')
              .text(`  [${sev.toUpperCase()}] ${f.name || f.description || 'Finding'}`, { continued: false });
            doc.fillColor('#000000');
            if (f.file) {
              doc.fontSize(10).text(`    File: ${f.file}${f.line ? ':' + f.line : ''}`);
            }
            if (f.description) {
              doc.fontSize(10).text(`    ${f.description}`, { width: 450 });
            }
            if (f.suggestion) {
              doc.fontSize(10).fillColor('#336633').text(`    Fix: ${f.suggestion}`, { width: 450 });
              doc.fillColor('#000000');
            }
            doc.moveDown(0.4);
          }
          doc.moveDown(0.3);
        }

        // Code analysis summary
        const okPerspectives = perspectives.filter(p => p.ok);
        doc.moveDown(0.5);
        doc.fontSize(11).fillColor('#000000');
        doc.text(`Perspectives analyzed: ${okPerspectives.length}/${perspectives.length}`);
        if (data.codeAnalysis.totalCost != null) {
          doc.text(`Total analysis cost: $${data.codeAnalysis.totalCost.toFixed(3)}`);
        }
      }
    }

    // ─── Footer ───
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999999')
      .text('Generated by Vela Analyzer', { align: 'center' });

    doc.end();

    stream.on('finish', () => {
      resolve({ ok: true, path: outputPath });
    });
  });
}

// ─── Main ───

async function main() {
  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case 'deps': {
      const { analyzeDeps } = require(path.join(__dirname, '..', 'hooks', 'shared', 'dep-analyzer.js'));
      const result = analyzeDeps({ cwd: process.cwd() });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'report': {
      const inputPath = getFlag('--input');
      if (!inputPath) {
        console.error('Error: --input <file> is required for the report subcommand.');
        printUsage();
        process.exit(1);
      }

      // Validate input file exists
      const resolvedInput = path.resolve(inputPath);
      if (!fs.existsSync(resolvedInput)) {
        console.error(`Error: Input file not found: ${resolvedInput}`);
        process.exit(1);
      }

      // Parse input JSON
      let data;
      try {
        const raw = fs.readFileSync(resolvedInput, 'utf-8');
        data = JSON.parse(raw);
      } catch (err) {
        console.error(`Error: Failed to parse input JSON: ${err.message}`);
        process.exit(1);
      }

      // Determine output path
      const outputFlag = getFlag('--output');
      const outputPath = outputFlag
        ? path.resolve(outputFlag)
        : path.resolve(`./vela-report-${Date.now()}.pdf`);

      const result = await generatePdf(data, outputPath);
      if (result.ok) {
        console.log(JSON.stringify({ ok: true, path: result.path }));
      } else {
        console.error(`Error: PDF generation failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const perspectivesRaw = getFlag('--perspectives');
      if (!perspectivesRaw) {
        console.error('Error: --perspectives <list> is required for the run subcommand.');
        console.error(`  Valid perspectives: ${VALID_PERSPECTIVES.join(', ')}`);
        printUsage();
        process.exit(1);
      }

      const requested = perspectivesRaw.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = requested.filter(p => !VALID_PERSPECTIVES.includes(p));
      if (invalid.length > 0) {
        console.error(`Error: Unknown perspective(s): ${invalid.join(', ')}`);
        console.error(`  Valid perspectives: ${VALID_PERSPECTIVES.join(', ')}`);
        process.exit(1);
      }

      const modelName = getFlag('--model') || 'haiku';
      if (!MODEL_MAP[modelName]) {
        console.error(`Error: Unknown model "${modelName}". Valid values: ${Object.keys(MODEL_MAP).join(', ')}`);
        process.exit(1);
      }

      const { sdkAnalyze } = require(path.join(__dirname, '..', 'hooks', 'shared', 'sdk-analyzer.js'));
      const result = await sdkAnalyze({
        perspectives: requested,
        cwd: process.cwd(),
        model: MODEL_MAP[modelName],
      });

      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'full': {
      // ─── Validate --items flag ───
      const VALID_ITEMS = ['deps', ...VALID_PERSPECTIVES];
      const itemsRaw = getFlag('--items');
      if (!itemsRaw) {
        console.error('Error: --items <list> is required for the full subcommand.');
        console.error(`  Valid items: ${VALID_ITEMS.join(', ')}`);
        printUsage();
        process.exit(1);
      }

      const items = itemsRaw.split(',').map(s => s.trim()).filter(Boolean);
      if (items.length === 0) {
        console.error('Error: --items list is empty.');
        console.error(`  Valid items: ${VALID_ITEMS.join(', ')}`);
        process.exit(1);
      }

      const invalidItems = items.filter(i => !VALID_ITEMS.includes(i));
      if (invalidItems.length > 0) {
        console.error(`Error: Unknown item(s): ${invalidItems.join(', ')}`);
        console.error(`  Valid items: ${VALID_ITEMS.join(', ')}`);
        process.exit(1);
      }

      // ─── Validate --model flag ───
      const fullModelName = getFlag('--model') || 'haiku';
      if (!MODEL_MAP[fullModelName]) {
        console.error(`Error: Unknown model "${fullModelName}". Valid values: ${Object.keys(MODEL_MAP).join(', ')}`);
        process.exit(1);
      }

      // ─── Determine output path ───
      const fullOutputFlag = getFlag('--output');
      const fullOutputPath = fullOutputFlag
        ? path.resolve(fullOutputFlag)
        : path.resolve(`./vela-report-${Date.now()}.pdf`);

      // ─── Run selected analyses ───
      const wantDeps = items.includes('deps');
      const sdkPerspectives = items.filter(i => i !== 'deps');
      const combinedData = {
        ok: true,
        selectedItems: items,
        generatedAt: new Date().toISOString(),
      };

      // Run dep-analyzer if requested
      if (wantDeps) {
        try {
          const { analyzeDeps } = require(path.join(__dirname, '..', 'hooks', 'shared', 'dep-analyzer.js'));
          const depResult = analyzeDeps({ cwd: process.cwd() });
          combinedData.deps = depResult;
        } catch (err) {
          combinedData.deps = { ok: false, error: err.message, findings: [], outdated: [], metadata: {} };
        }
      }

      // Run SDK analysis if any perspectives requested
      if (sdkPerspectives.length > 0) {
        try {
          const { sdkAnalyze } = require(path.join(__dirname, '..', 'hooks', 'shared', 'sdk-analyzer.js'));
          const sdkResult = await sdkAnalyze({
            perspectives: sdkPerspectives,
            cwd: process.cwd(),
            model: MODEL_MAP[fullModelName],
          });
          combinedData.codeAnalysis = sdkResult;
        } catch (err) {
          combinedData.codeAnalysis = {
            ok: false,
            error: err.message,
            perspectives: [],
            totalCost: 0,
            totalDurationMs: 0,
            model: MODEL_MAP[fullModelName],
          };
        }
      }

      // Determine overall ok status
      const depsOk = combinedData.deps ? combinedData.deps.ok : true;
      const codeOk = combinedData.codeAnalysis ? combinedData.codeAnalysis.ok : true;
      combinedData.ok = depsOk || codeOk; // ok if at least one succeeded

      // ─── Generate PDF ───
      const fullPdfResult = await generatePdf(combinedData, fullOutputPath);
      if (fullPdfResult.ok) {
        console.log(JSON.stringify({ ok: true, path: fullPdfResult.path, selectedItems: items }));
      } else {
        console.error(`Error: PDF generation failed: ${fullPdfResult.error}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: "${subcommand}"`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
