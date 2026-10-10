import { Component, type ReactNode } from 'react'

// Keeps a crashing mod from taking the terminal down with it: the mod's slot shows a notice and nothing else.
export class ModBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(`Claude Mods: ${this.props.title} failed`, error)
  }

  render() {
    if (this.state.failed)
      return (
        <p role="alert" className="text-muted-foreground p-3 text-xs">
          Claude Mods: {this.props.title} failed. The terminal is not affected.
        </p>
      )
    return this.props.children
  }
}
