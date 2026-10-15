import { describe, it, expectTypeOf } from 'vitest'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { postTags } from '../schema/posts'
import type {
  Board,
  NewBoard,
  BoardAccess,
  BoardSettings,
  Roadmap,
  NewRoadmap,
  Tag,
  NewTag,
  Post,
  NewPost,
  PostRoadmap,
  NewPostRoadmap,
  Vote,
  NewVote,
  Comment,
  NewComment,
  CommentReaction,
  NewCommentReaction,
  Integration,
  NewIntegration,
  IntegrationStatus,
  ChangelogEntry,
  NewChangelogEntry,
  CommentWithReplies,
  PostWithDetails,
  PostListItem,
} from '../types'

// types.ts exports no alias for the post_tags junction table, so these tests
// infer the row types from the table itself, as types.ts does for the others.
type PostTag = InferSelectModel<typeof postTags>
type NewPostTag = InferInsertModel<typeof postTags>

describe('Type definitions', () => {
  describe('Board types', () => {
    it('Board has correct shape', () => {
      expectTypeOf<Board>().toHaveProperty('id')
      expectTypeOf<Board>().toHaveProperty('slug')
      expectTypeOf<Board>().toHaveProperty('name')
      expectTypeOf<Board>().toHaveProperty('description')
      expectTypeOf<Board>().toHaveProperty('access')
      expectTypeOf<Board>().toHaveProperty('settings')
      expectTypeOf<Board>().toHaveProperty('createdAt')
      expectTypeOf<Board>().toHaveProperty('updatedAt')
    })

    it('NewBoard has required fields', () => {
      expectTypeOf<NewBoard>().toHaveProperty('slug')
      expectTypeOf<NewBoard>().toHaveProperty('name')
    })

    it('Board.id is a string', () => {
      expectTypeOf<Board['id']>().toBeString()
    })

    it('Board.access is a BoardAccess, and the legacy isPublic flag is gone', () => {
      // The per-action access matrix replaced the audience column (dropped in
      // migration 0080), which itself replaced the is_public boolean.
      expectTypeOf<Board['access']>().toEqualTypeOf<BoardAccess>()
      expectTypeOf<Board>().not.toHaveProperty('isPublic')
    })

    it('Board.settings is a BoardSettings', () => {
      expectTypeOf<Board['settings']>().toEqualTypeOf<BoardSettings>()
    })

    it('Board.createdAt is a Date', () => {
      expectTypeOf<Board['createdAt']>().toEqualTypeOf<Date>()
    })
  })

  describe('Roadmap types', () => {
    it('Roadmap has correct shape', () => {
      expectTypeOf<Roadmap>().toHaveProperty('id')
      expectTypeOf<Roadmap>().toHaveProperty('slug')
      expectTypeOf<Roadmap>().toHaveProperty('name')
      expectTypeOf<Roadmap>().toHaveProperty('isPublic')
      expectTypeOf<Roadmap>().toHaveProperty('position')
    })

    it('NewRoadmap has required fields', () => {
      expectTypeOf<NewRoadmap>().toHaveProperty('slug')
      expectTypeOf<NewRoadmap>().toHaveProperty('name')
    })
  })

  describe('Tag types', () => {
    it('Tag has correct shape', () => {
      expectTypeOf<Tag>().toHaveProperty('id')
      expectTypeOf<Tag>().toHaveProperty('name')
      expectTypeOf<Tag>().toHaveProperty('color')
    })

    it('NewTag has required fields', () => {
      expectTypeOf<NewTag>().toHaveProperty('name')
    })
  })

  describe('Post types', () => {
    it('Post has correct shape', () => {
      expectTypeOf<Post>().toHaveProperty('id')
      expectTypeOf<Post>().toHaveProperty('boardId')
      expectTypeOf<Post>().toHaveProperty('title')
      expectTypeOf<Post>().toHaveProperty('content')
      expectTypeOf<Post>().toHaveProperty('principalId')
      expectTypeOf<Post>().toHaveProperty('statusId')
      expectTypeOf<Post>().toHaveProperty('voteCount')
    })

    it('NewPost has required fields', () => {
      expectTypeOf<NewPost>().toHaveProperty('boardId')
      expectTypeOf<NewPost>().toHaveProperty('title')
      expectTypeOf<NewPost>().toHaveProperty('content')
    })

    it('Post.voteCount is a number', () => {
      expectTypeOf<Post['voteCount']>().toBeNumber()
    })
  })

  describe('Junction table types', () => {
    it('PostTag has correct shape', () => {
      expectTypeOf<PostTag>().toHaveProperty('postId')
      expectTypeOf<PostTag>().toHaveProperty('tagId')
    })

    it('NewPostTag has required fields', () => {
      expectTypeOf<NewPostTag>().toHaveProperty('postId')
      expectTypeOf<NewPostTag>().toHaveProperty('tagId')
    })

    it('PostRoadmap has correct shape', () => {
      expectTypeOf<PostRoadmap>().toHaveProperty('postId')
      expectTypeOf<PostRoadmap>().toHaveProperty('roadmapId')
    })

    it('NewPostRoadmap has required fields', () => {
      expectTypeOf<NewPostRoadmap>().toHaveProperty('postId')
      expectTypeOf<NewPostRoadmap>().toHaveProperty('roadmapId')
    })
  })

  describe('Vote types', () => {
    it('Vote has correct shape', () => {
      expectTypeOf<Vote>().toHaveProperty('id')
      expectTypeOf<Vote>().toHaveProperty('postId')
      expectTypeOf<Vote>().toHaveProperty('principalId')
      expectTypeOf<Vote>().toHaveProperty('createdAt')
    })

    it('NewVote has required fields', () => {
      expectTypeOf<NewVote>().toHaveProperty('postId')
      expectTypeOf<NewVote>().toHaveProperty('principalId')
    })
  })

  describe('Comment types', () => {
    it('Comment has correct shape', () => {
      expectTypeOf<Comment>().toHaveProperty('id')
      expectTypeOf<Comment>().toHaveProperty('postId')
      expectTypeOf<Comment>().toHaveProperty('parentId')
      expectTypeOf<Comment>().toHaveProperty('content')
      expectTypeOf<Comment>().toHaveProperty('createdAt')
    })

    it('NewComment has required fields', () => {
      expectTypeOf<NewComment>().toHaveProperty('postId')
      expectTypeOf<NewComment>().toHaveProperty('content')
    })

    it('Comment.parentId can be null', () => {
      // parentId is now CommentId | null (TypeId branded string)
      expectTypeOf<Comment['parentId']>().toMatchTypeOf<`comment_${string}` | null>()
    })
  })

  describe('CommentReaction types', () => {
    it('CommentReaction has correct shape', () => {
      expectTypeOf<CommentReaction>().toHaveProperty('id')
      expectTypeOf<CommentReaction>().toHaveProperty('commentId')
      expectTypeOf<CommentReaction>().toHaveProperty('principalId')
      expectTypeOf<CommentReaction>().toHaveProperty('emoji')
    })

    it('NewCommentReaction has required fields', () => {
      expectTypeOf<NewCommentReaction>().toHaveProperty('commentId')
      expectTypeOf<NewCommentReaction>().toHaveProperty('principalId')
      expectTypeOf<NewCommentReaction>().toHaveProperty('emoji')
    })
  })

  describe('Integration types', () => {
    it('Integration has correct shape', () => {
      expectTypeOf<Integration>().toHaveProperty('id')
      expectTypeOf<Integration>().toHaveProperty('integrationType')
      expectTypeOf<Integration>().toHaveProperty('status')
      expectTypeOf<Integration>().toHaveProperty('config')
    })

    it('NewIntegration has required fields', () => {
      expectTypeOf<NewIntegration>().toHaveProperty('integrationType')
    })

    it('IntegrationStatus is a string', () => {
      expectTypeOf<IntegrationStatus>().toBeString()
    })
  })

  describe('ChangelogEntry types', () => {
    it('ChangelogEntry has correct shape', () => {
      expectTypeOf<ChangelogEntry>().toHaveProperty('id')
      expectTypeOf<ChangelogEntry>().toHaveProperty('principalId')
      expectTypeOf<ChangelogEntry>().toHaveProperty('title')
      expectTypeOf<ChangelogEntry>().toHaveProperty('content')
      expectTypeOf<ChangelogEntry>().toHaveProperty('publishedAt')
    })

    it('NewChangelogEntry has required fields', () => {
      expectTypeOf<NewChangelogEntry>().toHaveProperty('title')
      expectTypeOf<NewChangelogEntry>().toHaveProperty('content')
    })

    it('ChangelogEntry belongs to no board', () => {
      // Changelog entries are workspace-wide; they link to shipped posts
      // through changelog_entry_posts instead of carrying a board id.
      expectTypeOf<ChangelogEntry>().not.toHaveProperty('boardId')
      expectTypeOf<NewChangelogEntry>().not.toHaveProperty('boardId')
    })

    it('ChangelogEntry.publishedAt can be null', () => {
      expectTypeOf<ChangelogEntry['publishedAt']>().toEqualTypeOf<Date | null>()
    })
  })

  describe('Composite types', () => {
    it('CommentWithReplies has recursive replies', () => {
      expectTypeOf<CommentWithReplies>().toHaveProperty('id')
      expectTypeOf<CommentWithReplies>().toHaveProperty('content')
      expectTypeOf<CommentWithReplies>().toHaveProperty('replies')
      expectTypeOf<CommentWithReplies>().toHaveProperty('reactions')
      expectTypeOf<CommentWithReplies['replies']>().toEqualTypeOf<CommentWithReplies[]>()
      expectTypeOf<CommentWithReplies['reactions']>().toEqualTypeOf<CommentReaction[]>()
    })

    it('PostWithDetails has all relations', () => {
      expectTypeOf<PostWithDetails>().toHaveProperty('id')
      expectTypeOf<PostWithDetails>().toHaveProperty('board')
      expectTypeOf<PostWithDetails>().toHaveProperty('tags')
      expectTypeOf<PostWithDetails>().toHaveProperty('roadmaps')
      expectTypeOf<PostWithDetails>().toHaveProperty('comments')
      expectTypeOf<PostWithDetails>().toHaveProperty('votes')
    })

    it('PostWithDetails.board is a Board', () => {
      expectTypeOf<PostWithDetails['board']>().toEqualTypeOf<Board>()
    })

    it('PostWithDetails carries typed relation arrays', () => {
      expectTypeOf<PostWithDetails['tags']>().toEqualTypeOf<Tag[]>()
      expectTypeOf<PostWithDetails['roadmaps']>().toEqualTypeOf<Roadmap[]>()
      expectTypeOf<PostWithDetails['comments']>().toEqualTypeOf<CommentWithReplies[]>()
      expectTypeOf<PostWithDetails['votes']>().toEqualTypeOf<Vote[]>()
    })

    it('PostListItem extends Post with a board summary, tags and counts', () => {
      expectTypeOf<PostListItem>().toHaveProperty('id')
      expectTypeOf<PostListItem>().toHaveProperty('title')
      expectTypeOf<PostListItem['board']>().toEqualTypeOf<Pick<Board, 'id' | 'name' | 'slug'>>()
      expectTypeOf<PostListItem['tags']>().toEqualTypeOf<Pick<Tag, 'id' | 'name' | 'color'>[]>()
      expectTypeOf<PostListItem['commentCount']>().toBeNumber()
      expectTypeOf<PostListItem['authorName']>().toEqualTypeOf<string | null>()
    })
  })
})
