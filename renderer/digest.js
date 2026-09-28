// Test/build output digests (plan item 34): spot the runner in a tile's plain-text output (ANSI
// already stripped by the caller) and boil it down to one summary line plus each failure's
// title, file:line, short message and first project stack frame. Everything else — passing
// tests, framework banners, full stack traces through node_modules/stdlib — stays in the tile.
// `digest(text)` returns null when no known runner is recognised, so the caller can fall back to
// `--errors`. No dependencies; loads as a plain script (sets window.OperantDigest) and in Node
// (module.exports) for tests.

const OperantDigest = (() => {
  // Stack/trace lines through these aren't "the project" even when they look like a real path.
  const NOT_PROJECT = /node_modules[\\/]|site-packages[\\/]|[\\/]lib[\\/]python\d|\.cargo[\\/]registry|[\\/]rustc[\\/]|\.nuget[\\/]|dotnet[\\/]sdk[\\/]|\bGOROOT\b|[\\/]go[\\/](pkg|src)[\\/]|<anonymous>|internal[\\/]testing|\(native\)|^node:/;
  const isProject = p => !!p && !NOT_PROJECT.test(p);

  // First 1-3 non-empty lines of a block, trimmed, as the short error message.
  const shortMessage = (lines, max) => {
    const cleaned = lines.map(l => l.replace(/\s+$/, '')).filter(l => l.trim().length);
    return cleaned.slice(0, max || 3).join('\n').trim();
  };

  // Cap a failures array at 20, remembering how many were dropped.
  const capFailures = list => {
    if (list.length <= 20) return { failures: list, more: 0 };
    return { failures: list.slice(0, 20), more: list.length - 20 };
  };

  const result = (runner, summary, failuresList, ok) => {
    const { failures, more } = capFailures(failuresList);
    return { runner, summary, failures, more, ok };
  };

  // ---------------------------------------------------------------- jest
  function jest(text) {
    const summaryMatch = text.match(/^Tests:\s+(.+)$/m);
    const suiteMatch = text.match(/^Test Suites:\s+(.+)$/m);
    if (!summaryMatch || !suiteMatch) return null;
    const ok = !/failed/.test(summaryMatch[1]);
    const summary = `Tests: ${summaryMatch[1].replace(/,?\s*\d+\s*total\.?$/, '').trim()}`;

    const failures = [];
    const blockRe = /^\s*●\s+(.+)$/gm;
    let m, positions = [];
    while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[1].trim() });
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].index;
      const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^Test Suites:/m);
      const block = text.slice(start, end === -1 ? text.length : end);
      const lines = block.split('\n').slice(1).filter(l => l.trim());
      let file = null, line = null;
      const frameRe = /\(?([^\s()]+\.[jt]sx?):(\d+):(\d+)\)?/g;
      let fm, chosen = null;
      while ((fm = frameRe.exec(block))) { if (isProject(fm[1])) { chosen = fm; break; } if (!chosen) chosen = fm; }
      if (chosen) { file = chosen[1]; line = parseInt(chosen[2], 10); }
      const msgLines = lines.filter(l => !/^\s*at\s/.test(l) && !/^\s*\d+\s*\|/.test(l) && !/^\s*\|/.test(l));
      failures.push({
        title: positions[i].title,
        file, line,
        message: shortMessage(msgLines, 3),
        frame: chosen ? chosen[0].replace(/^\(|\)$/g, '') : null,
      });
    }
    return result('jest', summary, failures, ok);
  }

  // ---------------------------------------------------------------- vitest
  function vitest(text) {
    const filesMatch = text.match(/^\s*Test Files\s+(.+)$/m);
    const testsMatch = text.match(/^\s*Tests\s+(.+)$/m);
    if (!filesMatch || !testsMatch) return null;
    const ok = !/failed/.test(testsMatch[1]);
    const summary = `Tests: ${testsMatch[1].trim()}`;

    const failures = [];
    const blockRe = /^\s*FAIL\s+(\S+)\s*>\s*(.+)$/gm;
    let m, positions = [];
    while ((m = blockRe.exec(text))) positions.push({ index: m.index, file: m[1], title: m[2].trim() });
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].index;
      const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^\s*Test Files\s+/m);
      const block = text.slice(start, end === -1 ? text.length : end);
      const lines = block.split('\n').slice(1).filter(l => l.trim());
      const frameRe = /❯\s+([^\s()]+):(\d+):(\d+)/g;
      let fm, chosen = null;
      while ((fm = frameRe.exec(block))) { if (isProject(fm[1])) { chosen = fm; break; } if (!chosen) chosen = fm; }
      const msgLines = lines.filter(l => !/❯/.test(l));
      failures.push({
        title: positions[i].title,
        file: chosen ? chosen[1] : positions[i].file,
        line: chosen ? parseInt(chosen[2], 10) : null,
        message: shortMessage(msgLines, 3),
        frame: chosen ? `${chosen[1]}:${chosen[2]}:${chosen[3]}` : null,
      });
    }
    return result('vitest', summary, failures, ok);
  }

  // ---------------------------------------------------------------- node:test
  function nodeTest(text) {
    const tap = text.match(/^# pass (\d+)/m) && text.match(/^# fail (\d+)/m);
    const spec = text.match(/^ℹ pass (\d+)/m) && text.match(/^ℹ fail (\d+)/m);
    if (!tap && !spec) return null;
    const passM = text.match(/^[#ℹ]\s*pass (\d+)/m);
    const failM = text.match(/^[#ℹ]\s*fail (\d+)/m);
    const passed = parseInt(passM[1], 10), failed = parseInt(failM[1], 10);
    const summary = `Tests: ${failed} failed, ${passed} passed`;
    const ok = failed === 0;

    const failures = [];
    if (tap) {
      const blockRe = /^not ok (\d+) - (.+)$/gm;
      let m, positions = [];
      while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[2].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
        const block = text.slice(start, end);
        const errMatch = block.match(/error:\s*\|-?\s*\n([\s\S]*?)\n\s*code:/) || block.match(/error:\s*(.+)/);
        const stackMatch = block.match(/stack:\s*\|-?\s*\n([\s\S]*?)(?:\n\s*---|\n#|$)/);
        let file = null, line = null, frame = null;
        if (stackMatch) {
          const frameRe = /\(?(?:file:\/\/\/)?([^\s()]+):(\d+):(\d+)\)?/g;
          let fm, chosen = null;
          while ((fm = frameRe.exec(stackMatch[1]))) { const p = fm[1].replace(/^\/([A-Za-z]:)/, '$1'); if (isProject(p)) { chosen = [fm[0], p, fm[2], fm[3]]; break; } if (!chosen) chosen = [fm[0], p, fm[2], fm[3]]; }
          if (chosen) { file = chosen[1]; line = parseInt(chosen[2], 10); frame = `${chosen[1]}:${chosen[2]}:${chosen[3]}`; }
        }
        const message = errMatch ? shortMessage(errMatch[1].split('\n'), 3) : '';
        failures.push({ title: positions[i].title, file, line, message, frame });
      }
    } else {
      const blockRe = /^\s*✖\s+(.+?)(?:\s*\(\d+(?:\.\d+)?ms\))?$/gm;
      let m, positions = [];
      while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[1].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^ℹ tests/m);
        const block = text.slice(start, end === -1 ? text.length : end);
        const lines = block.split('\n').slice(1).filter(l => l.trim());
        const frameRe = /at\s+.*?\(?([^\s()]+):(\d+):(\d+)\)?/g;
        let fm, chosen = null;
        while ((fm = frameRe.exec(block))) { if (isProject(fm[1])) { chosen = fm; break; } if (!chosen) chosen = fm; }
        const msgLines = lines.filter(l => !/^\s*at\s/.test(l));
        failures.push({
          title: positions[i].title,
          file: chosen ? chosen[1] : null,
          line: chosen ? parseInt(chosen[2], 10) : null,
          message: shortMessage(msgLines, 3),
          frame: chosen ? `${chosen[1]}:${chosen[2]}:${chosen[3]}` : null,
        });
      }
    }
    return result('node:test', summary, failures, ok);
  }

  // ---------------------------------------------------------------- mocha
  function mocha(text) {
    const passingM = text.match(/^\s*(\d+) passing(?:\s*\(([^)]+)\))?/m);
    const failingM = text.match(/^\s*(\d+) failing/m);
    if (!passingM && !failingM) return null;
    const passed = passingM ? parseInt(passingM[1], 10) : 0;
    const failed = failingM ? parseInt(failingM[1], 10) : 0;
    const summary = `Tests: ${failed} failed, ${passed} passed`;
    const ok = failed === 0;

    const failures = [];
    const blockRe = /^\s*(\d+)\)\s+(.+)$/gm;
    let m, positions = [];
    while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[2].trim() });
    // Only the second occurrence of each numbered block (after "N failing") is the detailed one;
    // the first is the inline "N) title" left in the run list. Use the ones with an error body.
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].index;
      const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
      const block = text.slice(start, end);
      if (!/Error|AssertionError|expected/i.test(block)) continue;
      const lines = block.split('\n').slice(1).filter(l => l.trim());
      const frameRe = /at\s+.*?\(?([^\s()]+):(\d+):(\d+)\)?/g;
      let fm, chosen = null;
      while ((fm = frameRe.exec(block))) { if (isProject(fm[1])) { chosen = fm; break; } if (!chosen) chosen = fm; }
      const msgLines = lines.filter(l => !/^\s*at\s/.test(l) && !/^\s*\+ expected/.test(l) && l.trim() !== '');
      let title = positions[i].title;
      // The detailed block's first line is often just the suite name, with the actual test title
      // on the next line ending in ":" — fold that in.
      const nameM = lines[0] && lines[0].match(/^\s*(.+?):\s*$/);
      if (nameM && !/Error|expected/i.test(nameM[1])) title = `${title} ${nameM[1].trim()}`;
      failures.push({
        title,
        file: chosen ? chosen[1] : null,
        line: chosen ? parseInt(chosen[2], 10) : null,
        message: shortMessage(msgLines, 3),
        frame: chosen ? `${chosen[1]}:${chosen[2]}:${chosen[3]}` : null,
      });
    }
    return result('mocha', summary, failures, ok);
  }

  // ---------------------------------------------------------------- pytest
  function pytest(text) {
    const finalM = text.match(/^=+\s*(.+?(?:passed|failed|error)[^\n=]*?)\s*=+\s*$/mi);
    if (!finalM && !/test session starts/.test(text)) return null;
    if (!finalM) return null;
    const summaryText = finalM[1].replace(/\s+in\s+[\d.]+s\s*$/i, '').trim();
    const ok = !/failed|error/i.test(summaryText);
    const summary = `Tests: ${summaryText}`;

    const failures = [];
    const failSection = text.split(/^=+\s*FAILURES\s*=+$/m)[1];
    if (failSection) {
      const upToSummary = failSection.split(/^=+\s*short test summary/mi)[0];
      const blockRe = /^_+\s+(.+?)\s+_+$/gm;
      let m, positions = [];
      while ((m = blockRe.exec(upToSummary))) positions.push({ index: m.index, title: m[1].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = i + 1 < positions.length ? positions[i + 1].index : upToSummary.length;
        const block = upToSummary.slice(start, end);
        const fileLineM = block.match(/^([\w./\\-]+\.py):(\d+):/m);
        const eLines = block.split('\n').filter(l => /^E\s/.test(l)).map(l => l.replace(/^E\s?/, ''));
        failures.push({
          title: positions[i].title,
          file: fileLineM ? fileLineM[1] : null,
          line: fileLineM ? parseInt(fileLineM[2], 10) : null,
          message: shortMessage(eLines.length ? eLines : block.split('\n'), 3),
          frame: fileLineM ? `${fileLineM[1]}:${fileLineM[2]}` : null,
        });
      }
    }
    return result('pytest', summary, failures, ok);
  }

  // ---------------------------------------------------------------- cargo (test + build)
  function cargo(text) {
    const trM = text.match(/^test result:\s*(ok|FAILED)\.\s*(\d+) passed;\s*(\d+) failed/m);
    if (trM) {
      const ok = trM[1] === 'ok';
      const summary = `Tests: ${trM[3]} failed, ${trM[2]} passed`;
      const failures = [];
      const blockRe = /^-{4,}\s+(\S+)\s+stdout\s+-{4,}$/gm;
      let m, positions = [];
      while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[1].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        let end = text.length;
        if (i + 1 < positions.length) end = positions[i + 1].index;
        else { const rest = text.slice(start).search(/\n\nfailures:\s*$/m); if (rest !== -1) end = start + rest; }
        const block = text.slice(start, end);
        const panicM = block.match(/panicked at ([^\n:]+):(\d+):(\d+):/);
        const bodyLines = block.split('\n').slice(1).filter(l => l.trim() && !/panicked at/.test(l) && !/^note:/.test(l));
        failures.push({
          title: positions[i].title,
          file: panicM ? panicM[1] : null,
          line: panicM ? parseInt(panicM[2], 10) : null,
          message: shortMessage(bodyLines, 3),
          frame: panicM ? `${panicM[1]}:${panicM[2]}:${panicM[3]}` : null,
        });
      }
      return result('cargo test', summary, failures, ok);
    }

    // cargo build / rustc errors
    if (/^error(\[E\d+\])?:/m.test(text) && /-->/.test(text)) {
      const failures = [];
      const blockRe = /^error(?:\[(E\d+)\])?:\s*(.+)$/gm;
      let m, allPositions = [];
      while ((m = blockRe.exec(text))) allPositions.push({ index: m.index, code: m[1], title: m[2].trim() });
      for (let i = 0; i < allPositions.length; i++) {
        const start = allPositions[i].index;
        const end = i + 1 < allPositions.length ? allPositions[i + 1].index : text.length;
        const block = text.slice(start, end);
        const locM = block.match(/-->\s*([^\s:]+):(\d+):(\d+)/);
        if (!locM) continue; // meta lines like "aborting due to..." carry no location
        failures.push({
          title: allPositions[i].code ? `${allPositions[i].code}: ${allPositions[i].title}` : allPositions[i].title,
          file: locM[1],
          line: parseInt(locM[2], 10),
          message: allPositions[i].title,
          frame: `${locM[1]}:${locM[2]}:${locM[3]}`,
        });
      }
      const errCount = failures.length;
      const summary = `Build: ${errCount} error${errCount === 1 ? '' : 's'}`;
      return result('cargo build', summary, failures, false);
    }
    return null;
  }

  // ---------------------------------------------------------------- go test / go build
  function goTest(text) {
    if (/^---\s+(PASS|FAIL):/m.test(text)) {
      const passN = (text.match(/^---\s+PASS:/gm) || []).length;
      const failN = (text.match(/^---\s+FAIL:/gm) || []).length;
      const ok = failN === 0;
      const summary = `Tests: ${failN} failed, ${passN} passed`;
      const failures = [];
      const blockRe = /^---\s+FAIL:\s+(\S+)/gm;
      let m, positions = [];
      while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[1].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        let end = text.length;
        if (i + 1 < positions.length) end = positions[i + 1].index;
        else { const rest = text.slice(start).search(/\n(FAIL|PASS|ok)\b/); if (rest !== -1) end = start + rest + 1; }
        const block = text.slice(start, end);
        const lineM = block.match(/^\s*([\w./-]+\.go):(\d+):\s*(.+)$/m);
        failures.push({
          title: positions[i].title,
          file: lineM ? lineM[1] : null,
          line: lineM ? parseInt(lineM[2], 10) : null,
          message: shortMessage(lineM ? [lineM[3]] : block.split('\n').slice(1), 3),
          frame: lineM ? `${lineM[1]}:${lineM[2]}` : null,
        });
      }
      return result('go test', summary, failures, ok);
    }

    // go build errors: "# pkg" header then "file.go:line:col: message" lines
    if (/^#\s+\S/m.test(text) && /^[^\s:]+\.go:\d+:\d+:/m.test(text)) {
      const failures = [];
      const lineRe = /^([^\s:]+\.go):(\d+):(\d+):\s*(.+)$/gm;
      let m;
      while ((m = lineRe.exec(text))) {
        failures.push({
          title: m[4].trim(),
          file: m[1], line: parseInt(m[2], 10),
          message: m[4].trim(),
          frame: `${m[1]}:${m[2]}:${m[3]}`,
        });
      }
      if (!failures.length) return null;
      const summary = `Build: ${failures.length} error${failures.length === 1 ? '' : 's'}`;
      return result('go build', summary, failures, false);
    }
    return null;
  }

  // ---------------------------------------------------------------- tsc
  function tsc(text) {
    const foundM = text.match(/^Found (\d+) errors?(?:\s+in\s+\d+\s+files?)?\.?/m);
    if (!foundM) return null;
    const errCount = parseInt(foundM[1], 10);
    const ok = errCount === 0;
    const summary = foundM[0].trim();
    const failures = [];
    const lineRe = /^(\S+\.tsx?):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)$/gm;
    let m;
    while ((m = lineRe.exec(text))) {
      failures.push({
        title: m[4],
        file: m[1], line: parseInt(m[2], 10),
        message: m[5].trim(),
        frame: `${m[1]}:${m[2]}:${m[3]}`,
      });
    }
    return result('tsc', summary, failures, ok);
  }

  // ---------------------------------------------------------------- eslint (stylish)
  function eslint(text) {
    const problemsM = text.match(/^[✖✖]\s*(\d+) problems?\s*\(([^)]+)\)/m);
    if (!problemsM) return null;
    const errN = (problemsM[2].match(/(\d+) errors?/) || [0, '0'])[1];
    const ok = parseInt(errN, 10) === 0;
    const summary = `Problems: ${problemsM[2]}`;

    const failures = [];
    const lines = text.split('\n');
    let currentFile = null;
    for (const line of lines) {
      const fileM = line.match(/^([^\s].*\.(?:[jt]sx?|mjs|cjs|vue))\s*$/);
      if (fileM) { currentFile = fileM[1]; continue; }
      const probM = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/);
      if (probM && currentFile) {
        failures.push({
          title: `${probM[3]}: ${probM[5]}`,
          file: currentFile, line: parseInt(probM[1], 10),
          message: probM[4].trim(),
          frame: `${currentFile}:${probM[1]}:${probM[2]}`,
        });
      }
    }
    return result('eslint', summary, failures, ok);
  }

  // ---------------------------------------------------------------- gradle
  function gradle(text) {
    const buildM = text.match(/^BUILD (FAILED|SUCCESSFUL)(?:\s+in\s+.+)?$/m);
    if (!buildM) return null;
    const ok = buildM[1] === 'SUCCESSFUL';
    const completedM = text.match(/^(\d+) tests? completed,\s*(\d+) failed/m);
    const summary = completedM ? `Tests: ${completedM[2]} failed, ${completedM[1] - completedM[2]} passed` : buildM[0].trim();

    const failures = [];
    // Test failures: "Class > method() FAILED"
    const testRe = /^(\S+) > (.+?)\(\) FAILED$/gm;
    let m, positions = [];
    while ((m = testRe.exec(text))) positions.push({ index: m.index, title: `${m[1]} > ${m[2]}()` });
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].index;
      const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^\d+ tests? completed/m);
      const block = text.slice(start, end === -1 ? text.length : end);
      const lines = block.split('\n').slice(1).filter(l => l.trim());
      const frameM = block.match(/at\s+[\w.$]+\(([^:]+):(\d+)\)/);
      const msgLines = lines.filter(l => !/^\s*at\s/.test(l));
      failures.push({
        title: positions[i].title,
        file: frameM ? frameM[1] : null,
        line: frameM ? parseInt(frameM[2], 10) : null,
        message: shortMessage(msgLines, 3),
        frame: frameM ? `${frameM[1]}:${frameM[2]}` : null,
      });
    }
    // Compile errors: "file: line: error: message"
    const compRe = /^(\S.*?):(\d+):\s*error:\s*(.+)$/gm;
    while ((m = compRe.exec(text))) {
      failures.push({ title: m[3].trim(), file: m[1], line: parseInt(m[2], 10), message: m[3].trim(), frame: `${m[1]}:${m[2]}` });
    }
    return result('gradle', summary, failures, ok);
  }

  // ---------------------------------------------------------------- maven (surefire)
  function maven(text) {
    const resultsM = text.match(/^Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)\s*$/m);
    if (!resultsM) return null;
    const [, run, fail, err, skip] = resultsM.map(Number);
    const ok = fail === 0 && err === 0;
    const failedTotal = fail + err;
    const summary = `Tests: ${failedTotal} failed, ${run - failedTotal - skip} passed`;

    const failures = [];
    const blockRe = /^(\S+)\(([\w.]+)\)\s+Time elapsed:[^\n]*<<<\s*(FAILURE|ERROR)!\s*$/gm;
    let m, positions = [];
    while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: `${m[2]}#${m[1]}` });
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i].index;
      const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^Results\s*:/m);
      const block = text.slice(start, end === -1 ? text.length : end);
      const lines = block.split('\n').slice(1).filter(l => l.trim());
      const frameM = block.match(/at\s+[\w.$]+\(([^:]+):(\d+)\)/);
      const msgLines = lines.filter(l => !/^\s*at\s/.test(l));
      failures.push({
        title: positions[i].title,
        file: frameM ? frameM[1] : null,
        line: frameM ? parseInt(frameM[2], 10) : null,
        message: shortMessage(msgLines, 3),
        frame: frameM ? `${frameM[1]}:${frameM[2]}` : null,
      });
    }
    return result('maven', summary, failures, ok);
  }

  // ---------------------------------------------------------------- dotnet test / build
  function dotnet(text) {
    const sumM = text.match(/^(Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/m);
    if (sumM) {
      const ok = sumM[1] === 'Passed';
      const summary = `Tests: ${sumM[2]} failed, ${sumM[3]} passed`;
      const failures = [];
      const blockRe = /^\s*Failed\s+(\S.*?)\s*(?:\[\d+.*\])?\s*$/gm;
      let m, positions = [];
      while ((m = blockRe.exec(text))) positions.push({ index: m.index, title: m[1].trim() });
      for (let i = 0; i < positions.length; i++) {
        const start = positions[i].index;
        const end = i + 1 < positions.length ? positions[i + 1].index : text.search(/^(Passed|Failed)!\s*-/m);
        const block = text.slice(start, end === -1 ? text.length : end);
        const frameM = block.match(/at\s+.*?\s+in\s+(.+?):line\s+(\d+)/);
        const msgLines = block.split('\n').slice(1).filter(l => l.trim() && !/^\s*at\s/.test(l) && !/^\s*Stack Trace:/.test(l));
        failures.push({
          title: positions[i].title,
          file: frameM ? frameM[1] : null,
          line: frameM ? parseInt(frameM[2], 10) : null,
          message: shortMessage(msgLines.filter(l => !/^\s*Error Message:/.test(l)), 3),
          frame: frameM ? `${frameM[1]}:${frameM[2]}` : null,
        });
      }
      return result('dotnet test', summary, failures, ok);
    }

    // MSBuild-style build errors
    if (/error CS\d+:/.test(text)) {
      const failures = [];
      const lineRe = /^(\S.*?)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+?)(?:\s*\[[^\]]+\])?$/gm;
      let m;
      while ((m = lineRe.exec(text))) {
        failures.push({ title: `${m[4]}: ${m[5].trim()}`, file: m[1], line: parseInt(m[2], 10), message: m[5].trim(), frame: `${m[1]}:${m[2]}:${m[3]}` });
      }
      if (!failures.length) return null;
      const summary = `Build: ${failures.length} error${failures.length === 1 ? '' : 's'}`;
      return result('dotnet build', summary, failures, false);
    }
    return null;
  }

  // ---------------------------------------------------------------- npm ERR! fallback
  function npmErr(text) {
    const errLines = text.split('\n').filter(l => /^npm ERR!/.test(l));
    if (!errLines.length) return null;
    const codeM = text.match(/npm ERR! code (\S+)/);
    const exitM = text.match(/npm ERR! (?:Exit status|code) (\S+)/) || text.match(/exit code (\d+)/i);
    const summary = codeM ? `npm error: ${codeM[1]}` : `npm error${exitM ? ' (exit ' + exitM[1] + ')' : ''}`;
    const message = errLines.slice(0, 6).map(l => l.replace(/^npm ERR!\s?/, '')).join('\n').trim();
    return result('npm', summary, [{ title: 'npm error', file: null, line: null, message, frame: null }], false);
  }

  // Order matters: more specific / cheaper checks first where formats could overlap.
  const RUNNERS = [jest, vitest, nodeTest, mocha, pytest, cargo, goTest, tsc, eslint, gradle, maven, dotnet, npmErr];

  function digest(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const runner of RUNNERS) {
      const r = runner(clean);
      if (r) return r;
    }
    return null;
  }

  return { digest };
})();

if (typeof window !== 'undefined') window.OperantDigest = OperantDigest.digest;
if (typeof module !== 'undefined') module.exports = OperantDigest.digest;
