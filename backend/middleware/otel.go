package middleware

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// HTTP creates a server span per request:
//   - extracts the W3C traceparent/baggage from incoming headers, so a trace
//     started upstream (nginx, the browser, another service) continues here
//   - records standard HTTP attributes plus the matched route (not the raw
//     path, so /users/42 doesn't create a unique span name per ID)
//   - reflects the response status into the span (5xx → ERROR)
//   - echoes `traceparent` back to the client for log/UI correlation
func HTTP() gin.HandlerFunc {
	tracer := otel.Tracer("lumina/http")
	return func(c *gin.Context) {
		ctx := otel.GetTextMapPropagator().Extract(
			c.Request.Context(),
			propagation.HeaderCarrier(c.Request.Header),
		)

		route := c.FullPath()
		if route == "" { // unmatched routes (404) — fall back to the raw path
			route = c.Request.URL.Path
		}

		scheme := c.Request.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			if c.Request.TLS != nil {
				scheme = "https"
			} else {
				scheme = "http"
			}
		}

		ctx, span := tracer.Start(ctx, c.Request.Method+" "+route,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.request.method", c.Request.Method),
				attribute.String("http.route", route),
				attribute.String("url.scheme", scheme),
				attribute.String("server.address", c.Request.Host),
				attribute.String("client.address", c.ClientIP()),
			),
		)
		c.Request = c.Request.WithContext(ctx)

		// Inject the trace ID BEFORE the handler writes the response — once
		// the body is flushed the header can no longer be added. The span
		// context already exists here, so the ID is final.
		hdr := http.Header{}
		otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(hdr))
		if tp := hdr.Get("traceparent"); tp != "" {
			c.Header("traceparent", tp)
		}

		c.Next()

		status := c.Writer.Status()
		span.SetAttributes(
			attribute.Int("http.response.status_code", status),
			attribute.Int64("http.response.body.size", int64(c.Writer.Size())),
		)
		switch {
		case status >= 500:
			span.SetStatus(codes.Error, "HTTP "+strconv.Itoa(status))
		case len(c.Errors) > 0:
			if first := c.Errors[0]; first != nil {
				span.RecordError(first.Err)
				span.SetStatus(codes.Error, first.Err.Error())
			}
		}

		// (traceparent was injected before c.Next — see above)

		span.End()
	}
}
