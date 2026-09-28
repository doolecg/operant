// electron-builder msiProjectCreated hook: the MSI closes any Operant still running from the install
// folder before it replaces files. Running the .msi by hand over an open (or hung) Operant otherwise
// stops halfway with "Error writing to file" and leaves the folder gutted.

const fs = require('fs');

// Inline JScript (no console window), matched by path so only this install's Operant is closed.
const script = `
var dir = Session.Property("APPLICATIONFOLDER").toLowerCase();
var procs = GetObject("winmgmts:").ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'Operant.exe'");
for (var e = new Enumerator(procs); !e.atEnd(); e.moveNext()) {
  var p = e.item();
  try { if (p.ExecutablePath && p.ExecutablePath.toLowerCase().indexOf(dir) === 0) p.Terminate(); } catch (x) {}
}
`;

const action = `
    <CustomAction Id="closeOperant" Script="jscript" Execute="immediate" Impersonate="yes" Return="ignore"><![CDATA[${script}]]></CustomAction>
    <InstallExecuteSequence>
      <Custom Action="closeOperant" Before="InstallValidate"/>
    </InstallExecuteSequence>
`;

module.exports = async function (projectFile) {
  const xml = fs.readFileSync(projectFile, 'utf8');
  if (!xml.includes('</Product>')) throw new Error('msi-close-app: no </Product> in ' + projectFile);
  fs.writeFileSync(projectFile, xml.replace('</Product>', action + '  </Product>'));
};
