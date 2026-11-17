declare module 'adblock-rs' {
  export class FilterSet { constructor(debug?: boolean); addFilters(text: string): unknown }
  export class Engine {
    constructor(filters: FilterSet)
    check(url: string, sourceUrl: string, requestType: string, method?: string, debug?: boolean): boolean | { should_block: boolean }
    urlCosmeticResources(url: string): { hide_selectors?: string[] }
  }
  const adblock: { FilterSet: typeof FilterSet; Engine: typeof Engine }
  export default adblock
}
