// One vocabulary for the source and the company's declared activities.
// These definitions guide interpretation; they never infer a role from keywords.
export const contractualRoleTaxonomy = Object.freeze({
  supply: "Fornire beni",
  execute: "Servizi/lavorazioni esecutivi senza ruolo più specifico",
  design: "Progettare/rivedere progetti",
  install: "Posare/mettere in opera",
  maintain: "Manutenzione/riparazione",
  operate: "Gestione continuativa",
  advise: "Consulenza",
  other:
    "Azione nota non classificabile, anche incarichi compositi; mai al posto di execute per servizi esecutivi",
});

export const contractualRoleDescription = Object.entries(
  contractualRoleTaxonomy,
)
  .map(([role, meaning]) => `${role}: ${meaning}`)
  .join(" ");
