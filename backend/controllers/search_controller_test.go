package controllers

import (
	"strings"
	"testing"

	"exporter/models"
)

func strPtr(s string) *string { return &s }

func TestBuildLuceneQuery_TenantPin(t *testing.T) {
	q := buildLuceneQuery(models.SearchParams{
		Tenant: strPtr("tenant1"),
	})
	if !strings.Contains(q, `tenant_id:"tenant1"`) {
		t.Fatalf("expected tenant pin, got: %s", q)
	}
}

func TestBuildLuceneQuery_TenantWithFilters(t *testing.T) {
	q := buildLuceneQuery(models.SearchParams{
		Tenant:   strPtr("tenant1"),
		SourceIP: strPtr("10.0.0.5"),
		Message:  strPtr("boot"),
	})
	for _, want := range []string{`tenant_id:"tenant1"`, `source_ip:10.0.0.5`, `message:boot`} {
		if !strings.Contains(q, want) {
			t.Fatalf("expected %q in query, got: %s", want, q)
		}
	}
	if !strings.HasPrefix(q, `tenant_id:"tenant1" AND`) {
		t.Fatalf("tenant pin should come first, got: %s", q)
	}
}

func TestBuildLuceneQuery_TenantWithRawQuery(t *testing.T) {
	q := buildLuceneQuery(models.SearchParams{
		Tenant:        strPtr("tenant1"),
		RawQuery:      strPtr("level:ERROR"),
		FromTimestamp: strPtr("1000"),
		ToTimestamp:   strPtr("2000"),
	})
	for _, want := range []string{`tenant_id:"tenant1"`, `timestamp:[1000 TO 2000]`, `level:ERROR`} {
		if !strings.Contains(q, want) {
			t.Fatalf("expected %q in query, got: %s", want, q)
		}
	}
}

func TestBuildLuceneQuery_NoTenant(t *testing.T) {
	q := buildLuceneQuery(models.SearchParams{
		Message: strPtr("boot"),
	})
	if strings.Contains(q, "tenant_id") {
		t.Fatalf("no tenant pin expected, got: %s", q)
	}
}

func TestBuildLuceneQuery_TenantEscaped(t *testing.T) {
	q := buildLuceneQuery(models.SearchParams{
		Tenant: strPtr(`a"b`),
	})
	if !strings.Contains(q, `tenant_id:"a\"b"`) {
		t.Fatalf("expected escaped tenant value, got: %s", q)
	}
}
