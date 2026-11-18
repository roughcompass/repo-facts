package prometheus

type Counter interface {
	Inc()
}
