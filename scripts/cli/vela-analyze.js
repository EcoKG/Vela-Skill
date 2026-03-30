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

// ─── Argument Parsing ───

const args = process.argv.slice(2);
const subcommand = args[0];

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function printUsage() {
  console.error(`Usage:
  node vela-analyze.js deps                          — Run dependency analysis (JSON stdout)
  node vela-analyze.js report --input <file> [--output <file>]  — Generate PDF report
  node vela-analyze.js run --perspectives <list> [--model haiku|sonnet]  — Run SDK code analysis

  run options:
    --perspectives  Comma-separated list of: security,bugs,performance,code-quality,architecture (required)
    --model         Analysis model: haiku (default) or sonnet`);
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

    // ─── Title Page ───
    doc.fontSize(24).text('Vela Analysis Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#666666')
      .text(new Date().toISOString().split('T')[0], { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(2);

    // ─── Summary Statistics ───
    const meta = data.metadata || {};
    const bySev = meta.bySeverity || {};
    doc.fontSize(16).text('Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text(`Total Vulnerabilities: ${meta.totalVulnerabilities || 0}`);
    doc.text(`  Critical: ${bySev.critical || 0}    High: ${bySev.high || 0}    Moderate: ${bySev.moderate || 0}    Low: ${bySev.low || 0}    Info: ${bySev.info || 0}`);
    doc.text(`Outdated Packages: ${meta.outdatedCount || 0}`);
    doc.moveDown(1.5);

    // ─── Vulnerability Findings ───
    const findings = data.findings || [];
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
    const outdated = data.outdated || [];
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

    // ─── Footer ───
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999999')
      .text('Generated by Vela Dependency Analyzer', { align: 'center' });

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
      const VALID_PERSPECTIVES = ['security', 'bugs', 'performance', 'code-quality', 'architecture'];
      const MODEL_MAP = {
        haiku: 'claude-haiku-4-5-20250929',
        sonnet: 'claude-sonnet-4-5-20250929',
      };

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
