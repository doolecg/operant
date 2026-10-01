import { useQuery } from '@tanstack/react-query'
import { call, keys, registerLive } from './core'

export const useUpdateStatus = () => useQuery({ queryKey: keys.update, queryFn: () => call('update:status') })

registerLive((b, qc) => [b.on('update', (s) => qc.setQueryData(keys.update, s))])
