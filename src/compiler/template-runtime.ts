/** Per-program template objects live outside interpreted user scopes. */
export const templateRuntimeSource = `
  var templateObjects = Object.create(null);
  var freezeTemplateObject = Object.freeze;
  var defineTemplateProperty = Object.defineProperty;
  function getTemplateObject(site, cooked, raw) {
    if (templateObjects[site] !== undefined) return templateObjects[site];
    defineTemplateProperty(cooked, 'raw', { value: freezeTemplateObject(raw) });
    freezeTemplateObject(cooked);
    templateObjects[site] = cooked;
    return cooked;
  }
`
