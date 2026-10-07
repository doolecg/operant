import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BudgetsEditor } from '@/components/cost/Budgets'

export function BudgetsSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Budgets</CardTitle>
        <CardDescription>
          Spending caps for the day, each project and each job. They warn first, then hold queued jobs. The same editor sits on the Usage tab.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BudgetsEditor />
      </CardContent>
    </Card>
  )
}
