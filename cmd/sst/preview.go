package main

import (
	"github.com/sst/ion/cmd/sst/cli"
	"github.com/sst/ion/cmd/sst/mosaic/ui"
	"github.com/sst/ion/pkg/project"
	"golang.org/x/sync/errgroup"
)

func CmdPreview(c *cli.Cli) error {
	p, err := c.InitProject()
	if err != nil {
		return err
	}
	defer p.Cleanup()

	var wg errgroup.Group
	defer wg.Wait()
	out := make(chan interface{})
	defer close(out)
	ui := ui.New(c.Context)
	wg.Go(func() error {
		for evt := range out {
			ui.Event(evt)
		}
		return nil
	})
	defer ui.Destroy()
	err = p.Run(c.Context, &project.StackInput{
		Command: "preview",
		Out:     out,
	})
	if err != nil {
		return err
	}
	return nil
}
