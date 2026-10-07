import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ImportExportPanel } from '@/components/cost/ImportExport'

export function ImportExportSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import and export</CardTitle>
        <CardDescription>Move your data from Operant 2.8.2, or to another machine.</CardDescription>
      </CardHeader>
      <CardContent>
        <ImportExportPanel />
      </CardContent>
    </Card>
  )
}
