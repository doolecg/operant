import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useSuperpowers } from '@/lib/queries'
import { Row } from '../parts'

export function SuperpowersSection() {
  const status = useSuperpowers()
  const s = status.data
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Superpowers</CardTitle>
        <CardDescription>The Superpowers skills pack that Operant's presets can use.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {!s ? (
          <p className="text-muted-foreground py-3 text-sm">{status.isError ? 'Could not read the Superpowers status.' : 'Checking…'}</p>
        ) : (
          <>
            <Row label="Installed">
              <Badge variant={s.installed ? 'secondary' : 'outline'}>{s.installed ? 'Yes' : 'No'}</Badge>
            </Row>
            {s.path && (
              <Row label="Path">
                <span className="text-muted-foreground max-w-96 truncate font-mono text-xs" title={s.path}>
                  {s.path}
                </span>
              </Row>
            )}
            {s.version && (
              <Row label="Version">
                <span className="font-mono text-xs">{s.version}</span>
              </Row>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
